// src/services/SniperService.ts
// Listens for new token launches on all active chains and auto-buys
// for users with sniping enabled.

import { getChain } from '../chains/registry';
import { NewPoolEvent } from '../chains/ChainPlugin';
import { UserService } from './UserService';
import { logger } from '../utils/logger';

interface SniperFilter {
  minLiquidityUsd: number;
  maxLiquidityUsd: number;
  requireRenounced?: boolean; // future: check mint authority
}

const DEFAULT_FILTER: SniperFilter = {
  minLiquidityUsd: 5000,
  maxLiquidityUsd: 500000,
};

export class SniperService {
  private unsubFns: Map<string, () => void> = new Map();

  constructor(
    private userService: UserService,
    private sendMessage: (telegramId: number, text: string) => Promise<void>
  ) {}

  async startChain(chainId: string, userIds: number[]): Promise<void> {
    if (this.unsubFns.has(chainId)) return; // already listening

    const chain = getChain(chainId);
    logger.info(`[Sniper] Starting listener for chain: ${chainId}`);

    const unsub = await chain.subscribeNewPools(async (event: NewPoolEvent) => {
      await this.handleNewPool(event, userIds);
    });

    this.unsubFns.set(chainId, unsub);
  }

  stopChain(chainId: string): void {
    const unsub = this.unsubFns.get(chainId);
    if (unsub) {
      unsub();
      this.unsubFns.delete(chainId);
      logger.info(`[Sniper] Stopped listener for chain: ${chainId}`);
    }
  }

  private async handleNewPool(event: NewPoolEvent, userIds: number[]): Promise<void> {
    logger.info(`[Sniper] New pool on ${event.chain}: ${event.tokenSymbol} (${event.tokenAddress})`);

    for (const userId of userIds) {
      try {
        const user = await this.userService.getUser(userId);
        const { settings } = user;

        if (!settings.autoBuyEnabled) continue;
        if (settings.activeChain !== event.chain) continue;

        // Apply filter
        if (!this.passesFilter(event, DEFAULT_FILTER)) {
          logger.debug(`[Sniper] ${event.tokenSymbol} filtered out`);
          continue;
        }

        const wallet = user.wallets[event.chain];
        if (!wallet) {
          await this.sendMessage(userId, `⚠️ Sniper hit but no ${event.chain} wallet found. Create one first!`);
          continue;
        }

        // Notify user before buying
        await this.sendMessage(userId,
          `🎯 *SNIPER HIT*\n\n` +
          `Token: *${event.tokenName}* ($${event.tokenSymbol})\n` +
          `Address: \`${event.tokenAddress}\`\n` +
          `Liquidity: $${event.initialLiquidityUsd.toLocaleString()}\n` +
          `Deployer: \`${event.deployer.slice(0, 8)}...\`\n\n` +
          `⏳ Buying ${settings.autoBuyAmount} ${getChain(event.chain).nativeSymbol}...`
        );

        // Execute buy
        const chain = getChain(event.chain);
        const result = await chain.buy({
          wallet,
          tokenAddress: event.tokenAddress,
          amountNative: settings.autoBuyAmount,
          slippageBps: settings.slippageBps,
        });

        // Auto-watch for TP/SL
        await this.userService.addWatchedToken(userId, event.tokenAddress);

        await this.sendMessage(userId,
          `✅ *SNIPED!*\n\n` +
          `Got: *${result.amountOut.toFixed(4)} ${event.tokenSymbol}*\n` +
          `Spent: ${result.amountIn} SOL\n` +
          `Price impact: ${result.priceImpact.toFixed(2)}%\n` +
          `[View TX](https://solscan.io/tx/${result.txHash})\n\n` +
          `TP ${settings.tpPercent}% / SL ${settings.slPercent}% set 🎯`
        );
      } catch (err: any) {
        logger.error(`[Sniper] Buy failed for user ${userId}:`, err.message);
        await this.sendMessage(userId, `❌ Sniper buy failed: ${err.message}`);
      }
    }
  }

  private passesFilter(event: NewPoolEvent, filter: SniperFilter): boolean {
    if (event.initialLiquidityUsd < filter.minLiquidityUsd) return false;
    if (event.initialLiquidityUsd > filter.maxLiquidityUsd) return false;
    return true;
  }
}
