// src/services/ReferralService.ts
// ─────────────────────────────────────────────────────────────────────────────
// Referral system: users get a unique invite link. When a referred user trades,
// the referrer earns a % of the bot fee. Tracks earnings in Redis.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'redis';
import { logger } from '../utils/logger';

export interface ReferralStats {
  referralCode: string;
  referrerId: number;
  referredUsers: number[];
  totalEarnedSol: number;
  pendingPayoutSol: number;
  lifetimeVolumeFromReferrals: number;
}

// Referrer earns 25% of the bot fee on every trade their referral makes
const REFERRAL_FEE_SHARE = 0.25;
// Bot fee is 0.1% (10 bps) — referrer gets 25% of that = 0.025%
const BOT_FEE_BPS = parseInt(process.env.BOT_FEE_BPS || '10');

export class ReferralService {
  private redis: ReturnType<typeof createClient>;

  constructor() {
    this.redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    this.redis.connect().catch(err => logger.error('[Referral] Redis connect error:', err.message));
  }

  // ── Code management ───────────────────────────────────────────────────────

  /** Generate or retrieve a user's referral code */
  async getOrCreateCode(userId: number): Promise<string> {
    const existing = await this.redis.get(`referral:code:${userId}`).catch(() => null);
    if (existing) return existing;

    // Generate a short alphanumeric code
    const code = this.generateCode(userId);
    await this.redis.set(`referral:code:${userId}`, code);
    await this.redis.set(`referral:code_to_user:${code}`, userId.toString());
    return code;
  }

  private generateCode(userId: number): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    let seed = userId;
    // deterministic prefix from userId + random suffix
    for (let i = 0; i < 3; i++) {
      code += chars[seed % chars.length];
      seed = Math.floor(seed / chars.length);
    }
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  /** Get the userId who owns a referral code */
  async getUserByCode(code: string): Promise<number | null> {
    const val = await this.redis.get(`referral:code_to_user:${code.toUpperCase()}`).catch(() => null);
    return val ? parseInt(val) : null;
  }

  // ── Attribution ───────────────────────────────────────────────────────────

  /** Call when a new user joins via a referral code */
  async registerReferral(newUserId: number, referralCode: string): Promise<boolean> {
    const referrerId = await this.getUserByCode(referralCode);
    if (!referrerId || referrerId === newUserId) return false;

    // Check if this user already has a referrer
    const existingReferrer = await this.redis.get(`referral:referred_by:${newUserId}`).catch(() => null);
    if (existingReferrer) return false;

    // Store the relationship
    await this.redis.set(`referral:referred_by:${newUserId}`, referrerId.toString());
    await this.redis.sAdd(`referral:referrals_of:${referrerId}`, newUserId.toString());

    logger.info(`[Referral] User ${newUserId} referred by ${referrerId} (code: ${referralCode})`);
    return true;
  }

  /** Returns the referrer's userId for a given user, or null */
  async getReferrer(userId: number): Promise<number | null> {
    const val = await this.redis.get(`referral:referred_by:${userId}`).catch(() => null);
    return val ? parseInt(val) : null;
  }

  // ── Earnings ──────────────────────────────────────────────────────────────

  /**
   * Call after every successful trade to credit the referrer.
   * @param traderId  - user who made the trade
   * @param volumeSol - total SOL value of the swap
   */
  async creditReferrer(traderId: number, volumeSol: number): Promise<{ referrerId: number; earnedSol: number } | null> {
    const referrerId = await this.getReferrer(traderId);
    if (!referrerId) return null;

    const botFeeSol = volumeSol * (BOT_FEE_BPS / 10000);
    const earnedSol = botFeeSol * REFERRAL_FEE_SHARE;

    // Increment earnings atomically
    await this.redis.incrByFloat(`referral:earnings:${referrerId}:pending`, earnedSol);
    await this.redis.incrByFloat(`referral:earnings:${referrerId}:lifetime`, earnedSol);
    await this.redis.incrByFloat(`referral:volume:${referrerId}`, volumeSol);

    logger.info(`[Referral] Credited ${earnedSol.toFixed(6)} SOL to referrer ${referrerId} from trade by ${traderId}`);
    return { referrerId, earnedSol };
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  async getStats(userId: number): Promise<ReferralStats> {
    const [code, pendingRaw, lifetimeRaw, volumeRaw, referralsRaw] = await Promise.all([
      this.getOrCreateCode(userId),
      this.redis.get(`referral:earnings:${userId}:pending`).catch(() => '0'),
      this.redis.get(`referral:earnings:${userId}:lifetime`).catch(() => '0'),
      this.redis.get(`referral:volume:${userId}`).catch(() => '0'),
      this.redis.sMembers(`referral:referrals_of:${userId}`).catch(() => [] as string[]),
    ]);

    return {
      referralCode: code,
      referrerId: userId,
      referredUsers: referralsRaw.map(Number),
      totalEarnedSol: parseFloat(lifetimeRaw || '0'),
      pendingPayoutSol: parseFloat(pendingRaw || '0'),
      lifetimeVolumeFromReferrals: parseFloat(volumeRaw || '0'),
    };
  }

  // ── Payouts ───────────────────────────────────────────────────────────────

  /** Called when bot pays out accumulated referral earnings to user's wallet */
  async claimPayout(userId: number): Promise<number> {
    const pendingRaw = await this.redis.get(`referral:earnings:${userId}:pending`).catch(() => '0');
    const pending = parseFloat(pendingRaw || '0');

    if (pending < 0.001) throw new Error('Minimum payout is 0.001 SOL');

    // Reset pending balance
    await this.redis.set(`referral:earnings:${userId}:pending`, '0');
    return pending;
  }

  /** Format stats for Telegram display */
  formatStats(stats: ReferralStats, botUsername: string): string {
    const link = `https://t.me/${botUsername}?start=ref_${stats.referralCode}`;
    return (
      `👥 *Referral Program*\n\n` +
      `Your Code: \`${stats.referralCode}\`\n` +
      `Invite Link:\n${link}\n\n` +
      `📊 *Stats*\n` +
      `Friends referred: ${stats.referredUsers.length}\n` +
      `Lifetime earned: ${stats.totalEarnedSol.toFixed(4)} SOL\n` +
      `Pending payout: ${stats.pendingPayoutSol.toFixed(6)} SOL\n` +
      `Referral volume: ${stats.lifetimeVolumeFromReferrals.toFixed(2)} SOL\n\n` +
      `💰 You earn *25% of the 0.1% bot fee* on every trade your referrals make.\n` +
      `Minimum payout: 0.001 SOL`
    );
  }
}
