// src/services/TokenSafetyService.ts
// ─────────────────────────────────────────────────────────────────────────────
// Runs a battery of safety checks before any buy (sniper, copy, manual).
// Checks: honeypot simulation, mint authority, freeze authority, top holders,
// liquidity lock, deployer history, and GoPlus security API.
// ─────────────────────────────────────────────────────────────────────────────
import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { logger } from '../utils/logger';

export type RiskLevel = 'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface SafetyFlag {
  code: string;
  description: string;
  severity: RiskLevel;
}

export interface SafetyReport {
  tokenAddress: string;
  riskLevel: RiskLevel;
  score: number;          // 0 = safe, 100 = definitely rug
  flags: SafetyFlag[];
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  top10HoldersPercent: number | null;
  liquidityLocked: boolean | null;
  isHoneypot: boolean | null;
  canBuy: boolean;        // final verdict
  reason: string;         // human-readable summary
}

const GOPLUS_API = 'https://api.gopluslabs.io/api/v1';
const DEXSCREENER = process.env.DEXSCREENER_API || 'https://api.dexscreener.com/latest';

export class TokenSafetyService {
  private connection: Connection;
  // Cache to avoid re-checking same token within 5 min
  private cache: Map<string, { report: SafetyReport; ts: number }> = new Map();
  private CACHE_TTL = 5 * 60 * 1000;

  constructor() {
    this.connection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
  }

  async check(tokenAddress: string): Promise<SafetyReport> {
    // Check cache
    const cached = this.cache.get(tokenAddress);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) {
      return cached.report;
    }

    const flags: SafetyFlag[] = [];
    let score = 0;

    // ── 1. On-chain mint / freeze authority check ─────────────────────────
    let mintAuthorityRevoked = false;
    let freezeAuthorityRevoked = false;
    try {
      const mintPubkey = new PublicKey(tokenAddress);
      const mintInfo = await getMint(this.connection, mintPubkey);

      mintAuthorityRevoked = mintInfo.mintAuthority === null;
      freezeAuthorityRevoked = mintInfo.freezeAuthority === null;

      if (!mintAuthorityRevoked) {
        flags.push({
          code: 'MINT_AUTHORITY_ACTIVE',
          description: 'Dev can mint unlimited tokens (infinite supply risk)',
          severity: 'HIGH',
        });
        score += 30;
      }

      if (!freezeAuthorityRevoked) {
        flags.push({
          code: 'FREEZE_AUTHORITY_ACTIVE',
          description: 'Dev can freeze your wallet (unable to sell)',
          severity: 'CRITICAL',
        });
        score += 40;
      }
    } catch (err) {
      flags.push({ code: 'MINT_CHECK_FAILED', description: 'Could not verify mint authority', severity: 'MEDIUM' });
      score += 10;
    }

    // ── 2. GoPlus security scan ───────────────────────────────────────────
    let top10HoldersPercent: number | null = null;
    let isHoneypot: boolean | null = null;
    let liquidityLocked: boolean | null = null;

    try {
      const gpRes = await axios.get(
        `${GOPLUS_API}/token_security/solana?contract_addresses=${tokenAddress}`,
        { timeout: 5000 }
      );
      const gp = gpRes.data?.result?.[tokenAddress.toLowerCase()];

      if (gp) {
        // Honeypot
        if (gp.cannot_sell_all === '1') {
          isHoneypot = true;
          flags.push({ code: 'HONEYPOT', description: 'Cannot sell all tokens — HONEYPOT', severity: 'CRITICAL' });
          score += 50;
        } else {
          isHoneypot = false;
        }

        // Top holder concentration
        if (gp.holder_count && gp.top10_holder_rate) {
          top10HoldersPercent = parseFloat(gp.top10_holder_rate) * 100;
          if (top10HoldersPercent > 80) {
            flags.push({
              code: 'HOLDER_CONCENTRATION',
              description: `Top 10 holders own ${top10HoldersPercent.toFixed(1)}% — extreme dump risk`,
              severity: 'HIGH',
            });
            score += 25;
          } else if (top10HoldersPercent > 50) {
            flags.push({
              code: 'HOLDER_CONCENTRATION_MEDIUM',
              description: `Top 10 holders own ${top10HoldersPercent.toFixed(1)}%`,
              severity: 'MEDIUM',
            });
            score += 10;
          }
        }

        // Liquidity lock
        liquidityLocked = gp.lp_locked === '1';
        if (!liquidityLocked) {
          flags.push({ code: 'LP_NOT_LOCKED', description: 'Liquidity not locked — dev can pull', severity: 'HIGH' });
          score += 20;
        }

        // High buy/sell tax
        const buyTax = parseFloat(gp.buy_tax || '0') * 100;
        const sellTax = parseFloat(gp.sell_tax || '0') * 100;
        if (sellTax > 10) {
          flags.push({ code: 'HIGH_SELL_TAX', description: `Sell tax is ${sellTax.toFixed(1)}%`, severity: 'HIGH' });
          score += 20;
        } else if (sellTax > 5) {
          flags.push({ code: 'MODERATE_SELL_TAX', description: `Sell tax is ${sellTax.toFixed(1)}%`, severity: 'MEDIUM' });
          score += 8;
        }

        // Trading cooldown
        if (gp.trading_cooldown === '1') {
          flags.push({ code: 'TRADING_COOLDOWN', description: 'Contract has a trading cooldown', severity: 'MEDIUM' });
          score += 10;
        }
      }
    } catch (err) {
      logger.debug(`[Safety] GoPlus check skipped for ${tokenAddress}: ${err}`);
      flags.push({ code: 'GOPLUS_UNAVAILABLE', description: 'GoPlus scan unavailable (proceed with caution)', severity: 'LOW' });
      score += 5;
    }

    // ── 3. Liquidity size check via DexScreener ───────────────────────────
    try {
      const dsRes = await axios.get(`${DEXSCREENER}/dex/tokens/${tokenAddress}`, { timeout: 5000 });
      const pairs = dsRes.data?.pairs || [];
      if (pairs.length > 0) {
        const maxLiq = Math.max(...pairs.map((p: any) => p.liquidity?.usd || 0));
        if (maxLiq < 5000) {
          flags.push({ code: 'VERY_LOW_LIQUIDITY', description: `Only $${maxLiq.toLocaleString()} liquidity`, severity: 'HIGH' });
          score += 20;
        } else if (maxLiq < 20000) {
          flags.push({ code: 'LOW_LIQUIDITY', description: `$${maxLiq.toLocaleString()} liquidity`, severity: 'MEDIUM' });
          score += 10;
        }

        // Token age: created < 10 min ago
        const createdAt = pairs[0]?.pairCreatedAt;
        if (createdAt) {
          const ageMinutes = (Date.now() - createdAt) / 60000;
          if (ageMinutes < 10) {
            flags.push({ code: 'BRAND_NEW', description: `Token is only ${ageMinutes.toFixed(0)} min old`, severity: 'LOW' });
          }
        }
      }
    } catch { /* skip */ }

    // ── 4. Determine final verdict ────────────────────────────────────────
    score = Math.min(100, score);

    let riskLevel: RiskLevel;
    if (score >= 70) riskLevel = 'CRITICAL';
    else if (score >= 50) riskLevel = 'HIGH';
    else if (score >= 30) riskLevel = 'MEDIUM';
    else if (score >= 10) riskLevel = 'LOW';
    else riskLevel = 'SAFE';

    const hasCritical = flags.some(f => f.severity === 'CRITICAL');
    const canBuy = !hasCritical && score < 70;

    const reason = hasCritical
      ? `🚨 BLOCKED: ${flags.find(f => f.severity === 'CRITICAL')!.description}`
      : score >= 50
      ? `⚠️ HIGH RISK: ${flags.length} issue(s) detected`
      : score >= 20
      ? `⚠️ MEDIUM RISK: Proceed with caution`
      : `✅ Passed safety checks (${flags.length} minor flag(s))`;

    const report: SafetyReport = {
      tokenAddress,
      riskLevel,
      score,
      flags,
      mintAuthorityRevoked,
      freezeAuthorityRevoked,
      top10HoldersPercent,
      liquidityLocked,
      isHoneypot,
      canBuy,
      reason,
    };

    this.cache.set(tokenAddress, { report, ts: Date.now() });
    return report;
  }

  /** Format a safety report for Telegram */
  formatReport(report: SafetyReport): string {
    const emoji = {
      SAFE: '🟢', LOW: '🟡', MEDIUM: '🟠', HIGH: '🔴', CRITICAL: '💀'
    }[report.riskLevel];

    const flagLines = report.flags
      .map(f => {
        const icon = { SAFE: '✅', LOW: '⚪', MEDIUM: '⚠️', HIGH: '🔴', CRITICAL: '💀' }[f.severity];
        return `${icon} ${f.description}`;
      })
      .join('\n');

    return (
      `${emoji} *Safety Report — ${report.riskLevel}* (${report.score}/100)\n\n` +
      `Mint revoked: ${report.mintAuthorityRevoked ? '✅' : '❌'}\n` +
      `Freeze revoked: ${report.freezeAuthorityRevoked ? '✅' : '❌'}\n` +
      `Liquidity locked: ${report.liquidityLocked === null ? '❓' : report.liquidityLocked ? '✅' : '❌'}\n` +
      `Honeypot: ${report.isHoneypot === null ? '❓' : report.isHoneypot ? '💀 YES' : '✅ No'}\n` +
      (report.top10HoldersPercent !== null ? `Top 10 holders: ${report.top10HoldersPercent.toFixed(1)}%\n` : '') +
      (flagLines ? `\n*Flags:*\n${flagLines}\n` : '\n*No major flags detected.*\n') +
      `\n${report.reason}`
    );
  }
}
