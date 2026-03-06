// src/services/PriceMonitorService.ts
// Polls token prices for all users' watched tokens and triggers TP/SL sells.

import cron from 'node-cron';
import { getChain } from '../chains/registry';
import { UserService } from './UserService';
import { logger } from '../utils/logger';

interface PriceEntry {
  buyPrice: number;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string;
}

export class PriceMonitorService {
  // userId → tokenAddress → entry
  private buyPrices: Map<number, Map<string, PriceEntry>> = new Map();
  private job: cron.ScheduledTask | null = null;

  constructor(
    private userService: UserService,
    private sendMessage: (telegramId: number, text: string) => Promise<void>
  ) {}

  /** Record the buy price for a user's token (call after each buy) */
  recordBuy(userId: number, chainId: string, tokenAddress: string, tokenSymbol: string, buyPrice: number): void {
    if (!this.buyPrices.has(userId)) this.buyPrices.set(userId, new Map());
    this.buyPrices.get(userId)!.set(tokenAddress, { buyPrice, chain: chainId, tokenAddress, tokenSymbol });
    logger.info(`[PriceMonitor] Tracking ${tokenSymbol} for user ${userId} @ $${buyPrice}`);
  }

  start(): void {
    // Run every 30 seconds
    this.job = cron.schedule('*/30 * * * * *', () => this.checkAll());
    logger.info('[PriceMonitor] Started — checking every 30s');
  }

  stop(): void {
    this.job?.destroy();
  }

  private async checkAll(): Promise<void> {
    for (const [userId, tokens] of this.buyPrices.entries()) {
      const user = await this.userService.getUser(userId).catch(() => null);
      if (!user) continue;

      for (const [tokenAddress, entry] of tokens.entries()) {
        try {
          const chain = getChain(entry.chain);
          const currentPrice = await chain.getTokenPrice(tokenAddress);
          const pnlPercent = ((currentPrice - entry.buyPrice) / entry.buyPrice) * 100;

          const { tpPercent, slPercent, slippageBps } = user.settings;

          if (pnlPercent >= tpPercent) {
            logger.info(`[PriceMonitor] TP hit for ${entry.tokenSymbol} — PnL: +${pnlPercent.toFixed(1)}%`);
            await this.executeSell(userId, entry, 'TAKE PROFIT', pnlPercent, slippageBps);
            tokens.delete(tokenAddress);

          } else if (pnlPercent <= -slPercent) {
            logger.info(`[PriceMonitor] SL hit for ${entry.tokenSymbol} — PnL: ${pnlPercent.toFixed(1)}%`);
            await this.executeSell(userId, entry, 'STOP LOSS', pnlPercent, slippageBps);
            tokens.delete(tokenAddress);
          }
        } catch (err: any) {
          logger.debug(`[PriceMonitor] Price check failed for ${tokenAddress}: ${err.message}`);
        }
      }
    }
  }

  private async executeSell(
    userId: number,
    entry: PriceEntry,
    reason: string,
    pnlPercent: number,
    slippageBps: number
  ): Promise<void> {
    const user = await this.userService.getUser(userId);
    const wallet = user.wallets[entry.chain];
    if (!wallet) return;

    try {
      const chain = getChain(entry.chain);
      const result = await chain.sell({
        wallet,
        tokenAddress: entry.tokenAddress,
        amountPercent: 100,
        slippageBps,
      });

      const emoji = pnlPercent > 0 ? '🟢' : '🔴';
      await this.sendMessage(userId,
        `${emoji} *${reason} TRIGGERED*\n\n` +
        `Token: *${entry.tokenSymbol}*\n` +
        `PnL: ${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%\n` +
        `Received: ${result.amountOut.toFixed(4)} ${chain.nativeSymbol}\n` +
        `[View TX](https://solscan.io/tx/${result.txHash})`
      );
    } catch (err: any) {
      await this.sendMessage(userId, `❌ Auto-sell failed for ${entry.tokenSymbol}: ${err.message}`);
    }
  }
}
