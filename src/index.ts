// src/index.ts
import 'dotenv/config';
import { registerChain } from './chains/registry';
import { SolanaPlugin } from './chains/solana/SolanaPlugin';
import { EthereumPlugin } from './chains/ethereum/EthereumPlugin';
import { UserService } from './services/UserService';
import { SniperService } from './services/SniperService';
import { CopyTradeService } from './services/CopyTradeService';
import { PriceMonitorService } from './services/PriceMonitorService';
import { TrendsService } from './services/TrendsService';
import { TokenSafetyService } from './services/TokenSafetyService';
import { ReferralService } from './services/ReferralService';
import { LimitOrderService } from './services/LimitOrderService';
import { PortfolioService } from './services/PortfolioService';
import { createBot } from './bot/bot';
import { logger } from './utils/logger';

async function main() {
  logger.info('🚀 Starting trading bot...');

  // ── Chain plugins ──────────────────────────────────────────────────────────
  registerChain(new SolanaPlugin());
  registerChain(new EthereumPlugin()); // graceful if ETH_RPC_URL not set

  // ── Shared message sender (bound after bot creation) ──────────────────────
  let sendTelegramMessage: (userId: number, text: string) => Promise<void> = async () => {};
  const sender = async (id: number, text: string) => sendTelegramMessage(id, text);

  // ── Services ───────────────────────────────────────────────────────────────
  const userService      = new UserService();
  const safetyService    = new TokenSafetyService();
  const referralService  = new ReferralService();
  const portfolioService = new PortfolioService();
  const trendsService    = new TrendsService();
  const sniperService    = new SniperService(userService, sender);
  const copyTradeService = new CopyTradeService(userService, sender);
  const priceMonitor     = new PriceMonitorService(userService, sender);
  const limitOrderService = new LimitOrderService(userService, sender);

  // ── Bot ────────────────────────────────────────────────────────────────────
  const bot = createBot(
    userService, sniperService, copyTradeService, priceMonitor,
    trendsService, safetyService, referralService, limitOrderService, portfolioService,
  );

  sendTelegramMessage = async (userId, text) => {
    await bot.api.sendMessage(userId, text, { parse_mode: 'Markdown' })
      .catch(e => logger.error(`[Bot] Message to ${userId} failed:`, e.message));
  };

  // ── Start background workers ───────────────────────────────────────────────
  priceMonitor.start();
  limitOrderService.start();
  logger.info('✅ Price monitor + limit orders active');

  // ── Start bot ──────────────────────────────────────────────────────────────
  await bot.start({
    onStart: (info) => logger.info(`✅ @${info.username} is live — all systems go 🚀`),
  });
}

main().catch(e => { logger.error('Fatal:', e); process.exit(1); });
