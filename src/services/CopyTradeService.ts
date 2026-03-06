// src/services/CopyTradeService.ts
// Mirrors trades from a target wallet to the user's wallet in real-time.

import { getChain } from '../chains/registry';
import { UserService } from './UserService';
import { logger } from '../utils/logger';

interface CopySession {
  userId: number;
  chainId: string;
  targetAddress: string;
  unsubscribe: () => void;
}

export class CopyTradeService {
  private sessions: CopySession[] = [];

  constructor(
    private userService: UserService,
    private sendMessage: (telegramId: number, text: string) => Promise<void>
  ) {}

  async startCopying(userId: number, chainId: string, targetAddress: string): Promise<void> {
    // Prevent duplicate sessions
    const existing = this.sessions.find(
      s => s.userId === userId && s.targetAddress === targetAddress && s.chainId === chainId
    );
    if (existing) throw new Error('Already copying this wallet');

    const chain = getChain(chainId);

    const unsubscribe = await chain.watchWallet(targetAddress, async (tx) => {
      logger.info(`[CopyTrade] ${tx.type.toUpperCase()} detected from ${targetAddress}: ${tx.tokenSymbol}`);

      const user = await this.userService.getUser(userId);
      const wallet = user.wallets[chainId];
      if (!wallet) return;

      const { settings } = user;

      // Scale trade size: use user's autoBuyAmount for buys, 100% sell for sells
      try {
        await this.sendMessage(userId,
          `📡 *COPY TRADE DETECTED*\n\n` +
          `Wallet: \`${targetAddress.slice(0, 8)}...\`\n` +
          `Action: *${tx.type.toUpperCase()}* ${tx.tokenSymbol}\n` +
          `Amount: ~${tx.amountNative.toFixed(4)} ${chain.nativeSymbol}\n\n` +
          `⏳ Mirroring...`
        );

        let result;
        if (tx.type === 'buy') {
          result = await chain.buy({
            wallet,
            tokenAddress: tx.tokenAddress,
            amountNative: settings.autoBuyAmount,
            slippageBps: settings.slippageBps,
          });
          await this.sendMessage(userId,
            `✅ *Copy buy executed*\n` +
            `Token: ${tx.tokenSymbol}\n` +
            `Spent: ${result.amountIn} ${chain.nativeSymbol}\n` +
            `Got: ${result.amountOut.toFixed(4)} ${tx.tokenSymbol}\n` +
            `[TX](https://solscan.io/tx/${result.txHash})`
          );
        } else {
          result = await chain.sell({
            wallet,
            tokenAddress: tx.tokenAddress,
            amountPercent: 100,
            slippageBps: settings.slippageBps,
          });
          await this.sendMessage(userId,
            `✅ *Copy sell executed*\n` +
            `Token: ${tx.tokenSymbol}\n` +
            `Received: ${result.amountOut.toFixed(4)} ${chain.nativeSymbol}\n` +
            `[TX](https://solscan.io/tx/${result.txHash})`
          );
        }
      } catch (err: any) {
        logger.error(`[CopyTrade] Execution failed for user ${userId}:`, err.message);
        await this.sendMessage(userId, `❌ Copy trade failed: ${err.message}`);
      }
    });

    this.sessions.push({ userId, chainId, targetAddress, unsubscribe });
    await this.userService.addCopyTarget(userId, targetAddress);
    logger.info(`[CopyTrade] Started copying ${targetAddress} for user ${userId}`);
  }

  async stopCopying(userId: number, targetAddress: string): Promise<void> {
    const idx = this.sessions.findIndex(
      s => s.userId === userId && s.targetAddress === targetAddress
    );
    if (idx === -1) throw new Error('No active copy session for that wallet');

    this.sessions[idx].unsubscribe();
    this.sessions.splice(idx, 1);
    await this.userService.removeCopyTarget(userId, targetAddress);
    logger.info(`[CopyTrade] Stopped copying ${targetAddress} for user ${userId}`);
  }

  getActiveSessions(userId: number): CopySession[] {
    return this.sessions.filter(s => s.userId === userId);
  }
}
