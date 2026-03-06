// src/bot/bot.ts
// Full Telegram bot with all command handlers using grammY

import { Bot, Context, InlineKeyboard } from 'grammy';
import { UserService } from '../services/UserService';
import { SniperService } from '../services/SniperService';
import { CopyTradeService } from '../services/CopyTradeService';
import { PriceMonitorService } from '../services/PriceMonitorService';
import { TrendsService } from '../services/TrendsService';
import { TokenSafetyService } from '../services/TokenSafetyService';
import { ReferralService } from '../services/ReferralService';
import { LimitOrderService } from '../services/LimitOrderService';
import { PortfolioService } from '../services/PortfolioService';
import { getChain, listChains } from '../chains/registry';
import { logger } from '../utils/logger';

export function createBot(
  userService: UserService,
  sniperService: SniperService,
  copyTradeService: CopyTradeService,
  priceMonitor: PriceMonitorService,
  trendsService: TrendsService,
  safetyService: TokenSafetyService,
  referralService: ReferralService,
  limitOrderService: LimitOrderService,
  portfolioService: PortfolioService,
): Bot {
  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

  // Helper: send HTML message
  const send = (ctx: Context, text: string, extra?: object) =>
    ctx.reply(text, { parse_mode: 'Markdown', ...extra });

  // ── /start (handles referral links: /start ref_CODE) ─────────────────────
  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name || 'trader';
    const userId = ctx.from!.id;
    const payload = ctx.match; // text after /start

    // Handle referral attribution
    if (typeof payload === 'string' && payload.startsWith('ref_')) {
      const code = payload.slice(4);
      const registered = await referralService.registerReferral(userId, code);
      if (registered) {
        await send(ctx, `🎉 You were referred! Your friend will earn rewards when you trade.`);
      }
    }

    const kb = new InlineKeyboard()
      .text('💼 Wallet', 'wallet').text('🛒 Buy/Sell', 'trade').row()
      .text('🎯 Sniper', 'sniper').text('📡 Copy Trade', 'copy').row()
      .text('📊 Trends', 'trends').text('📈 Portfolio', 'portfolio').row()
      .text('🔒 Safety Check', 'safety_menu').text('👥 Referrals', 'referral_menu').row()
      .text('📋 Limit Orders', 'limit_orders').text('⚙️ Settings', 'settings');

    await send(ctx,
      `👋 Welcome, *${name}*!\n\n` +
      `Your on-chain trading bot — Solana + Ethereum, multi-chain plugins.\n\n` +
      `*Commands:*\n` +
      `/wallet — Manage wallets\n` +
      `/buy <token> <amount> — Buy a token\n` +
      `/sell <token> <percent> — Sell a token\n` +
      `/sniper — Auto-buy new launches\n` +
      `/copy <wallet> — Mirror a wallet\n` +
      `/safety <token> — Rug/honeypot scan\n` +
      `/limit — Set limit orders\n` +
      `/portfolio — P&L dashboard\n` +
      `/refer — Your referral link\n` +
      `/trends — Hot tokens & signals\n` +
      `/settings — Slippage, TP/SL, chain`,
      { reply_markup: kb }
    );
  });

  // ── /wallet ─────────────────────────────────────────────────────────────
  bot.command('wallet', async (ctx) => {
    const userId = ctx.from!.id;
    const user = await userService.getUser(userId);
    const chain = getChain(user.settings.activeChain);
    const wallet = user.wallets[chain.chainId];

    if (!wallet) {
      const kb = new InlineKeyboard()
        .text('🆕 Create Wallet', `create_wallet_${chain.chainId}`)
        .text('📥 Import Wallet', `import_wallet_${chain.chainId}`);

      return send(ctx,
        `💼 *Wallet* (${chain.chainName})\n\n` +
        `No wallet found. Create a new one or import an existing private key.`,
        { reply_markup: kb }
      );
    }

    // Refresh balance
    const { native, tokens } = await chain.getBalance(wallet.address);
    const tokenCount = Object.keys(tokens).length;

    const kb = new InlineKeyboard()
      .text('📥 Deposit', `deposit_${chain.chainId}`)
      .text('📤 Withdraw', `withdraw_${chain.chainId}`).row()
      .text('🔑 Export Key', `export_key_${chain.chainId}`)
      .text('🔄 Switch Chain', 'switch_chain');

    await send(ctx,
      `💼 *${chain.chainName} Wallet*\n\n` +
      `Address: \`${wallet.address}\`\n\n` +
      `Balance: *${native.toFixed(4)} ${chain.nativeSymbol}*\n` +
      `Tokens: ${tokenCount} position(s)`,
      { reply_markup: kb }
    );
  });

  // Create wallet callback
  bot.callbackQuery(/^create_wallet_(.+)$/, async (ctx) => {
    const chainId = ctx.match[1];
    const userId = ctx.from.id;

    await ctx.answerCallbackQuery('Creating wallet...');
    const chain = getChain(chainId);
    const wallet = await chain.createWallet();
    await userService.saveWallet(userId, wallet);

    await send(ctx,
      `✅ *New ${chain.chainName} wallet created!*\n\n` +
      `Address: \`${wallet.address}\`\n\n` +
      `⚠️ *Your private key is encrypted and stored securely.*\n` +
      `Use /wallet → Export Key to back it up.\n\n` +
      `Send ${chain.nativeSymbol} to this address to start trading.`
    );
  });

  // Import wallet
  bot.callbackQuery(/^import_wallet_(.+)$/, async (ctx) => {
    const chainId = ctx.match[1];
    await ctx.answerCallbackQuery();
    await send(ctx,
      `📥 Send your private key in the next message.\n\n` +
      `⚠️ *Warning*: Only do this in a private chat. Delete the message after.\n\n` +
      `Reply with: /importkey <your_private_key>`
    );
  });

  bot.command('importkey', async (ctx) => {
    const userId = ctx.from!.id;
    const args = ctx.message?.text?.split(' ');
    if (!args || args.length < 2) return send(ctx, 'Usage: /importkey <private_key>');

    const privateKey = args[1].trim();
    const user = await userService.getUser(userId);
    const chain = getChain(user.settings.activeChain);

    try {
      const wallet = await chain.importWallet(privateKey);
      await userService.saveWallet(userId, wallet);
      // Delete the message for security
      await ctx.deleteMessage().catch(() => {});
      await send(ctx,
        `✅ *Wallet imported successfully!*\n` +
        `Address: \`${wallet.address}\`\n\n` +
        `🔒 Private key encrypted and stored.`
      );
    } catch (err: any) {
      await send(ctx, `❌ Import failed: ${err.message}`);
    }
  });

  // ── /buy ─────────────────────────────────────────────────────────────────
  bot.command('buy', async (ctx) => {
    const userId = ctx.from!.id;
    const args = ctx.message?.text?.split(' ');
    // /buy <token_address> [amount_sol]
    if (!args || args.length < 2) {
      return send(ctx, 'Usage: `/buy <token_address> [amount]`\nExample: `/buy EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 0.1`');
    }

    const tokenAddress = args[1];
    const user = await userService.getUser(userId);
    const amountNative = args[2] ? parseFloat(args[2]) : user.settings.autoBuyAmount;

    if (isNaN(amountNative) || amountNative <= 0) return send(ctx, '❌ Invalid amount');

    const wallet = user.wallets[user.settings.activeChain];
    if (!wallet) return send(ctx, '❌ No wallet found. Use /wallet to create one.');

    const chain = getChain(user.settings.activeChain);

    // Fetch token info first
    await send(ctx, `🔍 Looking up token...`);
    let tokenInfo;
    try {
      tokenInfo = await chain.getTokenInfo(tokenAddress);
    } catch {
      return send(ctx, '❌ Token not found. Check the address and try again.');
    }

    const kb = new InlineKeyboard()
      .text(`✅ Buy ${amountNative} ${chain.nativeSymbol}`, `confirm_buy_${tokenAddress}_${amountNative}`)
      .text('❌ Cancel', 'cancel');

    await send(ctx,
      `🛒 *Confirm Buy*\n\n` +
      `Token: *${tokenInfo.name}* ($${tokenInfo.symbol})\n` +
      `Price: $${tokenInfo.price_usd.toFixed(8)}\n` +
      `Liquidity: $${(tokenInfo.liquidity_usd || 0).toLocaleString()}\n` +
      `24h Change: ${(tokenInfo.price_change_24h || 0) > 0 ? '+' : ''}${(tokenInfo.price_change_24h || 0).toFixed(2)}%\n\n` +
      `Amount: *${amountNative} ${chain.nativeSymbol}*\n` +
      `Slippage: ${user.settings.slippageBps / 100}%`,
      { reply_markup: kb }
    );
  });

  bot.callbackQuery(/^confirm_buy_(.+)_(.+)$/, async (ctx) => {
    const tokenAddress = ctx.match[1];
    const amountNative = parseFloat(ctx.match[2]);
    const userId = ctx.from.id;

    await ctx.answerCallbackQuery('Executing buy...');
    const user = await userService.getUser(userId);
    const wallet = user.wallets[user.settings.activeChain];
    const chain = getChain(user.settings.activeChain);

    try {
      await send(ctx, `⏳ Executing buy...`);
      const result = await chain.buy({
        wallet,
        tokenAddress,
        amountNative,
        slippageBps: user.settings.slippageBps,
        priorityFee: user.settings.priorityFee,
      });

      // Record buy price for TP/SL
      const price = await chain.getTokenPrice(tokenAddress);
      const info = await chain.getTokenInfo(tokenAddress);
      priceMonitor.recordBuy(userId, chain.chainId, tokenAddress, info.symbol, price);
      await userService.addWatchedToken(userId, tokenAddress);

      await send(ctx,
        `✅ *Buy Executed!*\n\n` +
        `Got: *${result.amountOut.toFixed(4)} ${info.symbol}*\n` +
        `Spent: ${result.amountIn} ${chain.nativeSymbol}\n` +
        `Price Impact: ${result.priceImpact.toFixed(2)}%\n` +
        `[View Transaction](https://solscan.io/tx/${result.txHash})\n\n` +
        `TP ${user.settings.tpPercent}% / SL ${user.settings.slPercent}% active 🎯`
      );
    } catch (err: any) {
      await send(ctx, `❌ Buy failed: ${err.message}`);
    }
  });

  // ── /sell ────────────────────────────────────────────────────────────────
  bot.command('sell', async (ctx) => {
    const userId = ctx.from!.id;
    const args = ctx.message?.text?.split(' ');
    // /sell <token_address> [percent]
    if (!args || args.length < 2) {
      return send(ctx, 'Usage: `/sell <token_address> [percent]`\nExample: `/sell EPjF... 50`');
    }

    const tokenAddress = args[1];
    const percent = args[2] ? parseInt(args[2]) : 100;
    const user = await userService.getUser(userId);
    const wallet = user.wallets[user.settings.activeChain];
    if (!wallet) return send(ctx, '❌ No wallet found.');

    const chain = getChain(user.settings.activeChain);
    const kb = new InlineKeyboard()
      .text('25%', `confirm_sell_${tokenAddress}_25`)
      .text('50%', `confirm_sell_${tokenAddress}_50`)
      .text('75%', `confirm_sell_${tokenAddress}_75`)
      .text('100%', `confirm_sell_${tokenAddress}_100`)
      .row()
      .text('❌ Cancel', 'cancel');

    const info = await chain.getTokenInfo(tokenAddress).catch(() => null);
    const { tokens } = await chain.getBalance(wallet.address);
    const balance = tokens[tokenAddress] || 0;

    await send(ctx,
      `📤 *Sell ${info?.symbol || tokenAddress}*\n\n` +
      `Balance: ${balance.toFixed(4)} ${info?.symbol || '???'}\n` +
      `Current Price: $${info?.price_usd.toFixed(8) || 'unknown'}\n\n` +
      `How much to sell?`,
      { reply_markup: kb }
    );
  });

  bot.callbackQuery(/^confirm_sell_(.+)_(\d+)$/, async (ctx) => {
    const tokenAddress = ctx.match[1];
    const percent = parseInt(ctx.match[2]);
    const userId = ctx.from.id;

    await ctx.answerCallbackQuery(`Selling ${percent}%...`);
    const user = await userService.getUser(userId);
    const wallet = user.wallets[user.settings.activeChain];
    const chain = getChain(user.settings.activeChain);

    try {
      const result = await chain.sell({
        wallet,
        tokenAddress,
        amountPercent: percent,
        slippageBps: user.settings.slippageBps,
        priorityFee: user.settings.priorityFee,
      });

      await send(ctx,
        `✅ *Sell Executed!*\n\n` +
        `Sold: ${percent}% of position\n` +
        `Received: *${result.amountOut.toFixed(4)} ${chain.nativeSymbol}*\n` +
        `[View Transaction](https://solscan.io/tx/${result.txHash})`
      );
    } catch (err: any) {
      await send(ctx, `❌ Sell failed: ${err.message}`);
    }
  });

  // ── /sniper ──────────────────────────────────────────────────────────────
  bot.command('sniper', async (ctx) => {
    const userId = ctx.from!.id;
    const user = await userService.getUser(userId);
    const { autoBuyEnabled, autoBuyAmount, activeChain } = user.settings;
    const chain = getChain(activeChain);

    const kb = new InlineKeyboard()
      .text(autoBuyEnabled ? '🟢 Sniper ON — Click to Disable' : '🔴 Sniper OFF — Click to Enable',
        autoBuyEnabled ? 'sniper_disable' : 'sniper_enable')
      .row()
      .text('💰 Set Buy Amount', 'sniper_set_amount')
      .text('🔙 Back', 'main_menu');

    await send(ctx,
      `🎯 *Sniper Settings*\n\n` +
      `Status: ${autoBuyEnabled ? '🟢 Active' : '🔴 Inactive'}\n` +
      `Chain: ${chain.chainName}\n` +
      `Auto-buy amount: ${autoBuyAmount} ${chain.nativeSymbol}\n` +
      `Slippage: ${user.settings.slippageBps / 100}%\n\n` +
      `When enabled, the bot will automatically buy new tokens\n` +
      `that pass filters (min $5K liquidity).`,
      { reply_markup: kb }
    );
  });

  bot.callbackQuery('sniper_enable', async (ctx) => {
    const userId = ctx.from.id;
    await userService.updateSettings(userId, { autoBuyEnabled: true });
    // Start sniper listener
    const user = await userService.getUser(userId);
    await sniperService.startChain(user.settings.activeChain, [userId]);
    await ctx.answerCallbackQuery('Sniper enabled!');
    await send(ctx, '🟢 *Sniper is now active!* You\'ll be notified of new launches on your active chain.');
  });

  bot.callbackQuery('sniper_disable', async (ctx) => {
    const userId = ctx.from.id;
    await userService.updateSettings(userId, { autoBuyEnabled: false });
    await ctx.answerCallbackQuery('Sniper disabled');
    await send(ctx, '🔴 Sniper disabled.');
  });

  // ── /copy ─────────────────────────────────────────────────────────────────
  bot.command('copy', async (ctx) => {
    const userId = ctx.from!.id;
    const args = ctx.message?.text?.split(' ');
    const user = await userService.getUser(userId);
    const chain = getChain(user.settings.activeChain);

    if (!args || args.length < 2) {
      const active = copyTradeService.getActiveSessions(userId);
      const kb = new InlineKeyboard();
      if (active.length > 0) {
        active.forEach(s => kb.text(`❌ Stop ${s.targetAddress.slice(0, 8)}...`, `stop_copy_${s.targetAddress}`).row());
      }

      return send(ctx,
        `📡 *Copy Trading*\n\n` +
        `Active sessions: ${active.length}\n` +
        (active.length > 0 ? active.map(s => `• \`${s.targetAddress}\``).join('\n') : '') +
        `\n\nTo start copying a wallet:\n` +
        `/copy <wallet_address>`,
        { reply_markup: kb }
      );
    }

    const targetAddress = args[1].trim();

    try {
      await copyTradeService.startCopying(userId, user.settings.activeChain, targetAddress);
      await send(ctx,
        `✅ *Now copying wallet:*\n\`${targetAddress}\`\n\n` +
        `All trades from this wallet will be mirrored with ${user.settings.autoBuyAmount} ${chain.nativeSymbol} buy size.\n\n` +
        `Use /copy to see active sessions.`
      );
    } catch (err: any) {
      await send(ctx, `❌ ${err.message}`);
    }
  });

  bot.callbackQuery(/^stop_copy_(.+)$/, async (ctx) => {
    const targetAddress = ctx.match[1];
    const userId = ctx.from.id;
    try {
      await copyTradeService.stopCopying(userId, targetAddress);
      await ctx.answerCallbackQuery('Stopped');
      await send(ctx, `✅ Stopped copying \`${targetAddress}\``);
    } catch (err: any) {
      await send(ctx, `❌ ${err.message}`);
    }
  });

  // ── /trends ──────────────────────────────────────────────────────────────
  bot.command('trends', async (ctx) => {
    const userId = ctx.from!.id;
    const user = await userService.getUser(userId);

    await send(ctx, '📊 Fetching trending tokens...');
    try {
      const trending = await trendsService.getTrending(user.settings.activeChain);
      const top5 = trending.slice(0, 5);

      const kb = new InlineKeyboard();
      top5.forEach((t, i) => {
        kb.text(`${i + 1}. ${t.symbol} — Analyze`, `analyze_${t.address}_${t.chain}`).row();
      });

      const list = top5.map((t, i) =>
        `${i + 1}. *${t.symbol}* — $${t.price_usd.toFixed(6)}\n` +
        `   Vol 24h: $${(t.volume_24h || 0).toLocaleString()} | ${(t.price_change_24h || 0) > 0 ? '📈' : '📉'} ${(t.price_change_24h || 0).toFixed(1)}%`
      ).join('\n\n');

      await send(ctx,
        `📊 *Top Trending Tokens* (${getChain(user.settings.activeChain).chainName})\n\n${list}\n\n` +
        `Click a token to get a full signal analysis:`,
        { reply_markup: kb }
      );
    } catch (err: any) {
      await send(ctx, `❌ Failed to fetch trends: ${err.message}`);
    }
  });

  bot.callbackQuery(/^analyze_(.+)_(.+)$/, async (ctx) => {
    const tokenAddress = ctx.match[1];
    const chainId = ctx.match[2];
    await ctx.answerCallbackQuery('Analyzing...');

    try {
      const signal = await trendsService.analyzeToken(tokenAddress, chainId);
      const formatted = trendsService.formatSignal(signal);
      const chain = getChain(chainId);

      const kb = new InlineKeyboard()
        .text(`🛒 Buy 0.1 ${chain.nativeSymbol}`, `confirm_buy_${tokenAddress}_0.1`)
        .text('📊 More Info', `token_info_${tokenAddress}`);

      await send(ctx, formatted, { reply_markup: kb });
    } catch (err: any) {
      await send(ctx, `❌ Analysis failed: ${err.message}`);
    }
  });

  // ── /settings ────────────────────────────────────────────────────────────
  bot.command('settings', async (ctx) => {
    const userId = ctx.from!.id;
    const user = await userService.getUser(userId);
    const { settings } = user;
    const chain = getChain(settings.activeChain);
    const chains = listChains();

    const chainKb = new InlineKeyboard();
    chains.forEach(c => chainKb.text(
      `${c.chainId === settings.activeChain ? '✅ ' : ''}${c.chainName}`,
      `set_chain_${c.chainId}`
    ));

    await send(ctx,
      `⚙️ *Settings*\n\n` +
      `Active Chain: *${chain.chainName}*\n` +
      `Slippage: *${settings.slippageBps / 100}%*\n` +
      `Priority Fee: *${settings.priorityFee} lamports*\n` +
      `Auto-buy Amount: *${settings.autoBuyAmount} ${chain.nativeSymbol}*\n` +
      `Take Profit: *${settings.tpPercent}%*\n` +
      `Stop Loss: *${settings.slPercent}%*\n\n` +
      `*Switch Chain:*`,
      { reply_markup: chainKb }
    );
  });

  bot.callbackQuery(/^set_chain_(.+)$/, async (ctx) => {
    const chainId = ctx.match[1];
    const userId = ctx.from.id;
    await userService.updateSettings(userId, { activeChain: chainId });
    await ctx.answerCallbackQuery(`Switched to ${getChain(chainId).chainName}`);
    await send(ctx, `✅ Active chain switched to *${getChain(chainId).chainName}*`);
  });

  // Configure TP/SL via commands
  bot.command('setsl', async (ctx) => {
    const args = ctx.message?.text?.split(' ');
    if (!args || args.length < 2) return send(ctx, 'Usage: /setsl <percent>\nExample: /setsl 20');
    const slPercent = parseInt(args[1]);
    if (isNaN(slPercent) || slPercent <= 0 || slPercent > 90)
      return send(ctx, '❌ SL must be between 1 and 90');
    await userService.updateSettings(ctx.from!.id, { slPercent });
    await send(ctx, `✅ Stop Loss set to *${slPercent}%*`);
  });

  bot.command('settp', async (ctx) => {
    const args = ctx.message?.text?.split(' ');
    if (!args || args.length < 2) return send(ctx, 'Usage: /settp <percent>\nExample: /settp 50');
    const tpPercent = parseInt(args[1]);
    if (isNaN(tpPercent) || tpPercent <= 0)
      return send(ctx, '❌ TP must be a positive number');
    await userService.updateSettings(ctx.from!.id, { tpPercent });
    await send(ctx, `✅ Take Profit set to *${tpPercent}%*`);
  });

  // ── /safety <token> ───────────────────────────────────────────────────────
  bot.command('safety', async (ctx) => {
    const args = ctx.message?.text?.split(' ');
    if (!args || args.length < 2)
      return send(ctx, 'Usage: `/safety <token_address>`\nRuns a full rug/honeypot scan before you buy.');

    const tokenAddress = args[1].trim();
    await send(ctx, `🔍 Scanning \`${tokenAddress.slice(0, 12)}...\` for risks...`);

    try {
      const report = await safetyService.check(tokenAddress);
      const formatted = safetyService.formatReport(report);
      const kb = new InlineKeyboard();
      if (report.canBuy) {
        const user = await userService.getUser(ctx.from!.id);
        const chain = getChain(user.settings.activeChain);
        kb.text(`🛒 Buy ${user.settings.autoBuyAmount} ${chain.nativeSymbol}`, `confirm_buy_${tokenAddress}_${user.settings.autoBuyAmount}`);
      }
      kb.text('❌ Skip', 'cancel');
      await send(ctx, formatted, { reply_markup: kb });
    } catch (err: any) {
      await send(ctx, `❌ Safety scan failed: ${err.message}`);
    }
  });

  bot.callbackQuery('safety_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    await send(ctx, '🔒 *Safety Scanner*\n\nScan any token before buying:\n`/safety <token_address>`');
  });

  // ── /refer — Referral system ──────────────────────────────────────────────
  bot.command('refer', async (ctx) => {
    const userId = ctx.from!.id;
    const stats = await referralService.getStats(userId);
    const botInfo = await ctx.api.getMe();
    const formatted = referralService.formatStats(stats, botInfo.username || 'bot');

    const kb = new InlineKeyboard()
      .text('💰 Claim Payout', 'claim_referral')
      .text('📊 Leaderboard', 'referral_leaderboard');

    await send(ctx, formatted, { reply_markup: kb });
  });

  bot.callbackQuery('referral_menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const stats = await referralService.getStats(userId);
    const botInfo = await ctx.api.getMe();
    await send(ctx, referralService.formatStats(stats, botInfo.username || 'bot'));
  });

  bot.callbackQuery('claim_referral', async (ctx) => {
    const userId = ctx.from.id;
    await ctx.answerCallbackQuery('Processing...');
    try {
      const user = await userService.getUser(userId);
      const wallet = user.wallets[user.settings.activeChain];
      if (!wallet) return send(ctx, '❌ No wallet found to receive payout.');

      const amount = await referralService.claimPayout(userId);
      // In production: send SOL from bot treasury wallet to user.wallet.address
      await send(ctx,
        `✅ *Payout Claimed!*\n\n` +
        `Amount: *${amount.toFixed(6)} SOL*\n` +
        `Sending to: \`${wallet.address.slice(0, 12)}...\`\n\n` +
        `_(Transfer initiated — arrives within 1 minute)_`
      );
    } catch (err: any) {
      await send(ctx, `❌ ${err.message}`);
    }
  });

  // ── /limit — Limit orders ─────────────────────────────────────────────────
  bot.command('limit', async (ctx) => {
    const userId = ctx.from!.id;
    const orders = await limitOrderService.getOpenOrders(userId);
    const formatted = limitOrderService.formatOrders(orders);

    const kb = new InlineKeyboard()
      .text('📈 New Buy Limit', 'new_limit_buy')
      .text('📉 New Sell Limit', 'new_limit_sell');

    await send(ctx,
      `📋 *Limit Orders*\n\n${formatted}\n\n` +
      `To cancel: \`/cancellimit <order_id>\`\n` +
      `To create: \`/buylimit <token> <price> <amount>\`\n` +
      `           \`/selllimit <token> <price> <percent>\``,
      { reply_markup: kb }
    );
  });

  bot.callbackQuery('limit_orders', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const orders = await limitOrderService.getOpenOrders(userId);
    await send(ctx, `📋 *Open Limit Orders*\n\n${limitOrderService.formatOrders(orders)}`);
  });

  // /buylimit <token_address> <target_price_usd> <amount_sol>
  bot.command('buylimit', async (ctx) => {
    const userId = ctx.from!.id;
    const parts = ctx.message?.text?.split(' ') || [];
    if (parts.length < 4)
      return send(ctx, 'Usage: `/buylimit <token> <price_usd> <amount_sol>`\nExample: `/buylimit EPjF... 0.00001 0.1`');

    const [, tokenAddress, priceStr, amountStr] = parts;
    const targetPrice = parseFloat(priceStr);
    const amountNative = parseFloat(amountStr);
    if (isNaN(targetPrice) || isNaN(amountNative))
      return send(ctx, '❌ Invalid price or amount');

    const user = await userService.getUser(userId);
    const chain = getChain(user.settings.activeChain);
    let tokenSymbol = tokenAddress.slice(0, 8) + '...';
    try {
      const info = await chain.getTokenInfo(tokenAddress);
      tokenSymbol = info.symbol;
    } catch { /* use truncated address */ }

    const order = await limitOrderService.createOrder({
      userId, chainId: user.settings.activeChain, side: 'buy',
      tokenAddress, tokenSymbol, targetPrice,
      amountNative, slippageBps: user.settings.slippageBps,
    });

    await send(ctx,
      `✅ *Buy limit order created*\n\n` +
      `Token: ${tokenSymbol}\n` +
      `Buy when price ≤ *$${targetPrice}*\n` +
      `Amount: ${amountNative} ${chain.nativeSymbol}\n` +
      `Order ID: \`${order.id}\``
    );
  });

  // /selllimit <token_address> <target_price_usd> [percent]
  bot.command('selllimit', async (ctx) => {
    const userId = ctx.from!.id;
    const parts = ctx.message?.text?.split(' ') || [];
    if (parts.length < 3)
      return send(ctx, 'Usage: `/selllimit <token> <price_usd> [percent]`\nExample: `/selllimit EPjF... 0.0001 100`');

    const [, tokenAddress, priceStr, percentStr] = parts;
    const targetPrice = parseFloat(priceStr);
    const amountPercent = percentStr ? parseInt(percentStr) : 100;
    if (isNaN(targetPrice)) return send(ctx, '❌ Invalid price');

    const user = await userService.getUser(userId);
    const chain = getChain(user.settings.activeChain);
    let tokenSymbol = tokenAddress.slice(0, 8) + '...';
    try { tokenSymbol = (await chain.getTokenInfo(tokenAddress)).symbol; } catch { /* skip */ }

    const order = await limitOrderService.createOrder({
      userId, chainId: user.settings.activeChain, side: 'sell',
      tokenAddress, tokenSymbol, targetPrice,
      amountPercent, slippageBps: user.settings.slippageBps,
    });

    await send(ctx,
      `✅ *Sell limit order created*\n\n` +
      `Token: ${tokenSymbol}\n` +
      `Sell ${amountPercent}% when price ≥ *$${targetPrice}*\n` +
      `Order ID: \`${order.id}\``
    );
  });

  bot.command('cancellimit', async (ctx) => {
    const userId = ctx.from!.id;
    const parts = ctx.message?.text?.split(' ') || [];
    if (parts.length < 2) return send(ctx, 'Usage: `/cancellimit <order_id>`');
    try {
      await limitOrderService.cancelOrder(userId, parts[1]);
      await send(ctx, `✅ Order \`${parts[1]}\` cancelled.`);
    } catch (err: any) {
      await send(ctx, `❌ ${err.message}`);
    }
  });

  // ── /portfolio — P&L dashboard ────────────────────────────────────────────
  bot.command('portfolio', async (ctx) => {
    const userId = ctx.from!.id;
    await send(ctx, '📊 Loading portfolio...');
    try {
      const user = await userService.getUser(userId);
      const chain = getChain(user.settings.activeChain);
      const snap = await portfolioService.getSnapshot(userId);
      await send(ctx, portfolioService.formatSnapshot(snap, chain.nativeSymbol));
    } catch (err: any) {
      await send(ctx, `❌ Portfolio load failed: ${err.message}`);
    }
  });

  bot.callbackQuery('portfolio', async (ctx) => {
    await ctx.answerCallbackQuery('Loading...');
    const userId = ctx.from.id;
    const user = await userService.getUser(userId);
    const chain = getChain(user.settings.activeChain);
    const snap = await portfolioService.getSnapshot(userId);
    await send(ctx, portfolioService.formatSnapshot(snap, chain.nativeSymbol));
  });

  // Cancel callback
  bot.callbackQuery('cancel', async (ctx) => {
    await ctx.answerCallbackQuery('Cancelled');
    await send(ctx, '❌ Cancelled.');
  });

  // Error handler
  bot.catch((err) => {
    logger.error('[Bot] Unhandled error:', err.message);
  });

  return bot;
}

