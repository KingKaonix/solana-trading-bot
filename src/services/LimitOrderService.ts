// src/services/LimitOrderService.ts
// ─────────────────────────────────────────────────────────────────────────────
// Limit orders: set a target price to buy or sell. Polled every 15s.
// Stored in Redis. Supports GTC (good-till-cancelled) and expiry.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'redis';
import cron from 'node-cron';
import { getChain } from '../chains/registry';
import { UserService } from './UserService';
import { logger } from '../utils/logger';

export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'expired';

export interface LimitOrder {
  id: string;
  userId: number;
  chainId: string;
  side: OrderSide;
  tokenAddress: string;
  tokenSymbol: string;
  targetPrice: number;          // USD price to trigger
  amountNative?: number;        // SOL to spend (for buys)
  amountPercent?: number;       // % of balance to sell (for sells)
  slippageBps: number;
  status: OrderStatus;
  createdAt: number;
  expiresAt?: number;           // unix ms — optional TTL
  filledAt?: number;
  txHash?: string;
}

export class LimitOrderService {
  private redis: ReturnType<typeof createClient>;
  private job: cron.ScheduledTask | null = null;

  constructor(
    private userService: UserService,
    private sendMessage: (userId: number, text: string) => Promise<void>
  ) {
    this.redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    this.redis.connect().catch(err => logger.error('[LimitOrders] Redis error:', err.message));
  }

  // ── Order Management ──────────────────────────────────────────────────────

  async createOrder(order: Omit<LimitOrder, 'id' | 'status' | 'createdAt'>): Promise<LimitOrder> {
    const id = `lo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const full: LimitOrder = {
      ...order,
      id,
      status: 'open',
      createdAt: Date.now(),
    };

    await this.redis.hSet(`limitorders:${order.userId}`, id, JSON.stringify(full));
    logger.info(`[LimitOrders] Created ${order.side} order ${id} for user ${order.userId}`);
    return full;
  }

  async cancelOrder(userId: number, orderId: string): Promise<void> {
    const raw = await this.redis.hGet(`limitorders:${userId}`, orderId);
    if (!raw) throw new Error('Order not found');
    const order: LimitOrder = JSON.parse(raw);
    if (order.status !== 'open') throw new Error(`Order is already ${order.status}`);
    order.status = 'cancelled';
    await this.redis.hSet(`limitorders:${userId}`, orderId, JSON.stringify(order));
  }

  async getOpenOrders(userId: number): Promise<LimitOrder[]> {
    const all = await this.redis.hGetAll(`limitorders:${userId}`).catch(() => ({}));
    return Object.values(all)
      .map(v => JSON.parse(v) as LimitOrder)
      .filter(o => o.status === 'open');
  }

  async getAllOrders(userId: number): Promise<LimitOrder[]> {
    const all = await this.redis.hGetAll(`limitorders:${userId}`).catch(() => ({}));
    return Object.values(all).map(v => JSON.parse(v) as LimitOrder);
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  start(): void {
    this.job = cron.schedule('*/15 * * * * *', () => this.checkAll());
    logger.info('[LimitOrders] Polling every 15s');
  }

  stop(): void {
    this.job?.stop();
  }

  private async checkAll(): Promise<void> {
    // Get all user keys
    const keys = await this.redis.keys('limitorders:*').catch(() => [] as string[]);

    for (const key of keys) {
      const userId = parseInt(key.split(':')[1]);
      const orders = await this.getOpenOrders(userId);

      for (const order of orders) {
        try {
          // Check expiry
          if (order.expiresAt && Date.now() > order.expiresAt) {
            order.status = 'expired';
            await this.redis.hSet(key, order.id, JSON.stringify(order));
            await this.sendMessage(userId, `⏰ Limit order expired: ${order.side.toUpperCase()} ${order.tokenSymbol} @ $${order.targetPrice}`);
            continue;
          }

          // Get current price
          const chain = getChain(order.chainId);
          const currentPrice = await chain.getTokenPrice(order.tokenAddress);

          const triggered =
            (order.side === 'buy' && currentPrice <= order.targetPrice) ||
            (order.side === 'sell' && currentPrice >= order.targetPrice);

          if (!triggered) continue;

          // Execute
          const user = await this.userService.getUser(userId);
          const wallet = user.wallets[order.chainId];
          if (!wallet) {
            logger.warn(`[LimitOrders] No wallet for user ${userId} chain ${order.chainId}`);
            continue;
          }

          await this.sendMessage(userId,
            `🎯 *Limit Order Triggered!*\n` +
            `${order.side.toUpperCase()} ${order.tokenSymbol}\n` +
            `Target: $${order.targetPrice} | Current: $${currentPrice.toFixed(8)}\n` +
            `⏳ Executing...`
          );

          let result;
          if (order.side === 'buy') {
            result = await chain.buy({
              wallet,
              tokenAddress: order.tokenAddress,
              amountNative: order.amountNative!,
              slippageBps: order.slippageBps,
            });
          } else {
            result = await chain.sell({
              wallet,
              tokenAddress: order.tokenAddress,
              amountPercent: order.amountPercent || 100,
              slippageBps: order.slippageBps,
            });
          }

          // Mark filled
          order.status = 'filled';
          order.filledAt = Date.now();
          order.txHash = result.txHash;
          await this.redis.hSet(key, order.id, JSON.stringify(order));

          await this.sendMessage(userId,
            `✅ *Limit Order Filled!*\n` +
            `${order.side.toUpperCase()} ${order.tokenSymbol}\n` +
            `Got: ${result.amountOut.toFixed(4)}\n` +
            `[View TX](https://solscan.io/tx/${result.txHash})`
          );
        } catch (err: any) {
          logger.error(`[LimitOrders] Execution failed for order ${order.id}:`, err.message);
          await this.sendMessage(userId, `❌ Limit order failed for ${order.tokenSymbol}: ${err.message}`);
        }
      }
    }
  }

  formatOrders(orders: LimitOrder[]): string {
    if (orders.length === 0) return 'No open limit orders.';
    return orders.map((o, i) =>
      `${i + 1}. ${o.side.toUpperCase()} *${o.tokenSymbol}* @ $${o.targetPrice}\n` +
      `   ${o.side === 'buy' ? `Amount: ${o.amountNative} SOL` : `Sell: ${o.amountPercent}%`} | ID: \`${o.id}\``
    ).join('\n\n');
  }
}
