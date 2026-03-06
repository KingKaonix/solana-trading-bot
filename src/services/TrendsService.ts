// src/services/TrendsService.ts
// Fetches trending tokens and generates basic opportunity signals.

import axios from 'axios';
import { TokenInfo } from '../chains/ChainPlugin';
import { getChain, listChains } from '../chains/registry';

export interface TrendSignal {
  token: TokenInfo;
  signals: string[];
  score: number; // 0-100 confidence
  recommendation: 'STRONG BUY' | 'BUY' | 'WATCH' | 'AVOID';
}

const DEXSCREENER = process.env.DEXSCREENER_API || 'https://api.dexscreener.com/latest';

export class TrendsService {
  /** Get trending tokens across all registered chains */
  async getTrending(chainId?: string): Promise<TokenInfo[]> {
    const chains = chainId ? [getChain(chainId)] : listChains();
    const results: TokenInfo[] = [];

    for (const chain of chains) {
      try {
        const trending = await chain.getTrendingTokens(15);
        results.push(...trending);
      } catch { /* skip failed chains */ }
    }

    return results.sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0));
  }

  /** Analyze a token and return opportunity signals */
  async analyzeToken(address: string, chainId: string): Promise<TrendSignal> {
    const chain = getChain(chainId);
    const token = await chain.getTokenInfo(address);

    const signals: string[] = [];
    let score = 0;

    // ── Volume signal ───────────────────────────────────────
    if ((token.volume_24h || 0) > 1_000_000) {
      signals.push('📈 High 24h volume (>$1M)');
      score += 20;
    } else if ((token.volume_24h || 0) > 100_000) {
      signals.push('📊 Moderate 24h volume (>$100K)');
      score += 10;
    }

    // ── Price momentum ──────────────────────────────────────
    const change = token.price_change_24h || 0;
    if (change > 50) {
      signals.push(`🚀 Strong upward momentum (+${change.toFixed(0)}% 24h)`);
      score += 25;
    } else if (change > 20) {
      signals.push(`📈 Positive momentum (+${change.toFixed(0)}% 24h)`);
      score += 15;
    } else if (change < -30) {
      signals.push(`📉 Significant downtrend (${change.toFixed(0)}% 24h)`);
      score -= 20;
    }

    // ── Liquidity safety ────────────────────────────────────
    const liq = token.liquidity_usd || 0;
    if (liq > 500_000) {
      signals.push('💧 Strong liquidity (>$500K) — low rug risk');
      score += 20;
    } else if (liq > 50_000) {
      signals.push('💧 Decent liquidity (>$50K)');
      score += 10;
    } else if (liq < 10_000) {
      signals.push('⚠️ Very low liquidity (<$10K) — high risk');
      score -= 30;
    }

    // ── Market cap opportunity ──────────────────────────────
    const mc = token.market_cap_usd || 0;
    if (mc > 0 && mc < 1_000_000) {
      signals.push('💎 Low market cap (<$1M) — high upside potential');
      score += 15;
    } else if (mc > 100_000_000) {
      signals.push('🏔️ Large cap — lower risk, lower upside');
      score += 5;
    }

    // Normalize score
    score = Math.max(0, Math.min(100, score));

    let recommendation: TrendSignal['recommendation'];
    if (score >= 70) recommendation = 'STRONG BUY';
    else if (score >= 50) recommendation = 'BUY';
    else if (score >= 30) recommendation = 'WATCH';
    else recommendation = 'AVOID';

    return { token, signals, score, recommendation };
  }

  /** Format a signal for Telegram message */
  formatSignal(signal: TrendSignal): string {
    const { token, signals, score, recommendation } = signal;
    const emoji = { 'STRONG BUY': '🟢', 'BUY': '🟡', 'WATCH': '⚪', 'AVOID': '🔴' }[recommendation];

    return (
      `${emoji} *${token.symbol}* — ${recommendation}\n` +
      `Score: ${score}/100\n\n` +
      `💰 Price: $${token.price_usd.toFixed(8)}\n` +
      `📊 24h Volume: $${(token.volume_24h || 0).toLocaleString()}\n` +
      `💧 Liquidity: $${(token.liquidity_usd || 0).toLocaleString()}\n` +
      `📈 24h Change: ${(token.price_change_24h || 0) > 0 ? '+' : ''}${(token.price_change_24h || 0).toFixed(2)}%\n\n` +
      `Signals:\n${signals.map(s => `• ${s}`).join('\n')}\n\n` +
      `\`${token.address}\``
    );
  }
}
