// src/services/UserService.ts
// Handles per-user wallet storage and settings — backed by Redis
import { createClient, RedisClientType } from 'redis';
import { WalletInfo } from '../chains/ChainPlugin';
import { logger } from '../utils/logger';

export interface UserSettings {
  telegramId: number;
  activeChain: string;          // e.g. 'solana'
  slippageBps: number;          // default 100 (1%)
  priorityFee: number;          // lamports
  autoBuyAmount: number;        // SOL/ETH to spend on sniper hits
  autoBuyEnabled: boolean;
  copyTargets: string[];        // wallets being copied
  tpPercent: number;            // take profit %
  slPercent: number;            // stop loss %
  watchedTokens: string[];      // tokens with active TP/SL
}

export interface UserData {
  settings: UserSettings;
  wallets: Record<string, WalletInfo>; // chainId → wallet
}

const DEFAULT_SETTINGS = (telegramId: number): UserSettings => ({
  telegramId,
  activeChain: 'solana',
  slippageBps: 100,
  priorityFee: 50000,
  autoBuyAmount: 0.1,
  autoBuyEnabled: false,
  copyTargets: [],
  tpPercent: 50,
  slPercent: 20,
  watchedTokens: [],
});

export class UserService {
  private redis: ReturnType<typeof createClient>;
  private ready = false;

  constructor() {
    this.redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    this.redis.on('error', (err) => logger.error('[Redis] error:', err.message));
    this.redis.connect().then(() => {
      this.ready = true;
      logger.info('[Redis] Connected');
    });
  }

  private key(telegramId: number) {
    return `user:${telegramId}`;
  }

  async getUser(telegramId: number): Promise<UserData> {
    const raw = await this.redis.get(this.key(telegramId));
    if (raw) return JSON.parse(raw);
    // First time — create defaults
    const fresh: UserData = {
      settings: DEFAULT_SETTINGS(telegramId),
      wallets: {},
    };
    await this.saveUser(telegramId, fresh);
    return fresh;
  }

  async saveUser(telegramId: number, data: UserData): Promise<void> {
    await this.redis.set(this.key(telegramId), JSON.stringify(data));
  }

  async updateSettings(telegramId: number, patch: Partial<UserSettings>): Promise<UserSettings> {
    const user = await this.getUser(telegramId);
    user.settings = { ...user.settings, ...patch };
    await this.saveUser(telegramId, user);
    return user.settings;
  }

  async saveWallet(telegramId: number, wallet: WalletInfo): Promise<void> {
    const user = await this.getUser(telegramId);
    user.wallets[wallet.chain] = wallet;
    await this.saveUser(telegramId, user);
  }

  async getWallet(telegramId: number, chainId: string): Promise<WalletInfo | null> {
    const user = await this.getUser(telegramId);
    return user.wallets[chainId] || null;
  }

  async addCopyTarget(telegramId: number, targetAddress: string): Promise<void> {
    const user = await this.getUser(telegramId);
    if (!user.settings.copyTargets.includes(targetAddress)) {
      user.settings.copyTargets.push(targetAddress);
      await this.saveUser(telegramId, user);
    }
  }

  async removeCopyTarget(telegramId: number, targetAddress: string): Promise<void> {
    const user = await this.getUser(telegramId);
    user.settings.copyTargets = user.settings.copyTargets.filter(a => a !== targetAddress);
    await this.saveUser(telegramId, user);
  }

  async addWatchedToken(telegramId: number, tokenAddress: string): Promise<void> {
    const user = await this.getUser(telegramId);
    if (!user.settings.watchedTokens.includes(tokenAddress)) {
      user.settings.watchedTokens.push(tokenAddress);
      await this.saveUser(telegramId, user);
    }
  }
}
