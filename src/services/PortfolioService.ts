// src/services/PortfolioService.ts
// ─────────────────────────────────────────────────────────────────────────────
// Tracks every buy/sell event, computes P&L per position and overall.
// Stored in Redis. Can generate a full portfolio dashboard snapshot.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'redis';
import { getChain } from '../chains/registry';
import { logger } from '../utils/logger';

export interface Trade {
  id: string;
  userId: number;
  chainId: string;
  side: 'buy' | 'sell';
  tokenAddress: string;
  tokenSymbol: string;
  amountToken: number;
  amountNative: number;
  priceUsd: number;
  nativePriceUsd: number;  // SOL/ETH price at time of trade
  txHash: string;
  timestamp: number;
}

export interface Position {
  tokenAddress: string;
  tokenSymbol: string;
  chainId: string;
  totalBought: number;       // tokens bought
  totalSold: number;         // tokens sold
  remaining: number;         // tokens still held
  avgBuyPrice: number;       // USD
  totalCostNative: number;   // SOL/ETH spent
  totalReceivedNative: number; // SOL/ETH from sells
  realizedPnlNative: number;
  unrealizedPnlNative?: number;
  currentPrice?: number;
}

export interface PortfolioSnapshot {
  userId: number;
  positions: Position[];
  totalRealizedPnl: number;   // SOL
  totalUnrealizedPnl: number; // SOL
  totalTrades: number;
  winRate: number;            // % of profitable trades
  bestTrade?: { symbol: string; pnlPercent: number };
  worstTrade?: { symbol: string; pnlPercent: number };
}

export class PortfolioService {
  private redis: ReturnType<typeof createClient>;

  constructor() {
    this.redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    this.redis.connect().catch(err => logger.error('[Portfolio] Redis error:', err.message));
  }

  // ── Record trades ─────────────────────────────────────────────────────────

  async recordTrade(trade: Omit<Trade, 'id' | 'timestamp'>): Promise<void> {
    const id = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const full: Trade = { ...trade, id, timestamp: Date.now() };
    await this.redis.lPush(`portfolio:trades:${trade.userId}`, JSON.stringify(full));
    // Keep last 1000 trades
    await this.redis.lTrim(`portfolio:trades:${trade.userId}`, 0, 999);
    logger.debug(`[Portfolio] Recorded ${trade.side} trade for user ${trade.userId}: ${trade.tokenSymbol}`);
  }

  async getTrades(userId: number, limit = 50): Promise<Trade[]> {
    const raw = await this.redis.lRange(`portfolio:trades:${userId}`, 0, limit - 1).catch(() => []);
    return raw.map(r => JSON.parse(r) as Trade);
  }

  // ── Build positions ───────────────────────────────────────────────────────

  async buildPositions(userId: number): Promise<Position[]> {
    const trades = await this.getTrades(userId, 1000);
    const posMap = new Map<string, Position>();

    for (const t of trades.reverse()) { // process oldest first
      const key = `${t.chainId}:${t.tokenAddress}`;
      if (!posMap.has(key)) {
        posMap.set(key, {
          tokenAddress: t.tokenAddress,
          tokenSymbol: t.tokenSymbol,
          chainId: t.chainId,
          totalBought: 0,
          totalSold: 0,
          remaining: 0,
          avgBuyPrice: 0,
          totalCostNative: 0,
          totalReceivedNative: 0,
          realizedPnlNative: 0,
        });
      }

      const pos = posMap.get(key)!;

      if (t.side === 'buy') {
        // Update avg buy price
        const prevCost = pos.avgBuyPrice * pos.totalBought;
        pos.totalBought += t.amountToken;
        pos.totalCostNative += t.amountNative;
        pos.avgBuyPrice = pos.totalBought > 0
          ? (prevCost + t.priceUsd * t.amountToken) / pos.totalBought
          : t.priceUsd;
        pos.remaining += t.amountToken;
      } else {
        // Calculate realized PnL
        const costBasis = (t.amountToken / pos.totalBought) * pos.totalCostNative;
        pos.realizedPnlNative += t.amountNative - costBasis;
        pos.totalSold += t.amountToken;
        pos.totalReceivedNative += t.amountNative;
        pos.remaining = Math.max(0, pos.remaining - t.amountToken);
      }
    }

    return Array.from(posMap.values()).filter(p => p.totalBought > 0);
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  async getSnapshot(userId: number): Promise<PortfolioSnapshot> {
    const positions = await this.buildPositions(userId);

    // Enrich with current prices
    let totalUnrealized = 0;
    let totalRealized = 0;
    let wins = 0, losses = 0;
    let best: { symbol: string; pnlPercent: number } | undefined;
    let worst: { symbol: string; pnlPercent: number } | undefined;

    for (const pos of positions) {
      totalRealized += pos.realizedPnlNative;

      // Fetch live price for open positions
      if (pos.remaining > 0) {
        try {
          const chain = getChain(pos.chainId);
          const currentPrice = await chain.getTokenPrice(pos.tokenAddress);
          pos.currentPrice = currentPrice;

          const currentValueNative = (pos.remaining * currentPrice) /
            (pos.totalCostNative / pos.totalBought > 0
              ? pos.avgBuyPrice / (pos.totalCostNative / pos.totalBought)
              : 1);

          // Approximate unrealized in SOL terms
          const costBasisForRemaining = (pos.remaining / pos.totalBought) * pos.totalCostNative;
          const currentValueApprox = pos.remaining * currentPrice / pos.avgBuyPrice * costBasisForRemaining;
          pos.unrealizedPnlNative = currentValueApprox - costBasisForRemaining;
          totalUnrealized += pos.unrealizedPnlNative;
        } catch { /* skip if price unavailable */ }
      }

      // Win/loss from realized
      if (pos.realizedPnlNative > 0) wins++;
      else if (pos.realizedPnlNative < 0) losses++;

      const pnlPercent = pos.totalCostNative > 0
        ? ((pos.realizedPnlNative + (pos.unrealizedPnlNative || 0)) / pos.totalCostNative) * 100
        : 0;

      if (!best || pnlPercent > best.pnlPercent) best = { symbol: pos.tokenSymbol, pnlPercent };
      if (!worst || pnlPercent < worst.pnlPercent) worst = { symbol: pos.tokenSymbol, pnlPercent };
    }

    const total = wins + losses;
    return {
      userId,
      positions,
      totalRealizedPnl: totalRealized,
      totalUnrealizedPnl: totalUnrealized,
      totalTrades: await this.redis.lLen(`portfolio:trades:${userId}`).catch(() => 0),
      winRate: total > 0 ? (wins / total) * 100 : 0,
      bestTrade: best,
      worstTrade: worst,
    };
  }

  formatSnapshot(snap: PortfolioSnapshot, nativeSymbol = 'SOL'): string {
    const realSign = snap.totalRealizedPnl >= 0 ? '+' : '';
    const unrealSign = snap.totalUnrealizedPnl >= 0 ? '+' : '';

    const posLines = snap.positions
      .filter(p => p.remaining > 0)
      .slice(0, 8)
      .map(p => {
        const pnl = p.unrealizedPnlNative || 0;
        const sign = pnl >= 0 ? '📈' : '📉';
        return `${sign} *${p.tokenSymbol}*: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} ${nativeSymbol}`;
      })
      .join('\n');

    return (
      `📊 *Portfolio Dashboard*\n\n` +
      `Realized P&L: *${realSign}${snap.totalRealizedPnl.toFixed(4)} ${nativeSymbol}*\n` +
      `Unrealized P&L: *${unrealSign}${snap.totalUnrealizedPnl.toFixed(4)} ${nativeSymbol}*\n` +
      `Total trades: ${snap.totalTrades}\n` +
      `Win rate: ${snap.winRate.toFixed(1)}%\n` +
      (snap.bestTrade ? `🏆 Best: ${snap.bestTrade.symbol} (+${snap.bestTrade.pnlPercent.toFixed(1)}%)\n` : '') +
      (snap.worstTrade ? `💀 Worst: ${snap.worstTrade.symbol} (${snap.worstTrade.pnlPercent.toFixed(1)}%)\n` : '') +
      (posLines ? `\n*Open Positions:*\n${posLines}` : '\n_No open positions_')
    );
  }
}
