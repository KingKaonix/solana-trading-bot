# 🤖 Solana Telegram Trading Bot

A modular, production-grade crypto trading bot for Telegram — Solana-first with multi-chain plugins.

---

## ⚡ Quick Deploy (3 commands)

```bash
chmod +x deploy.sh
./deploy.sh setup          # install deps, generate encryption secret
./deploy.sh rpc            # provision Solana RPC (interactive wizard)
# edit .env → set TELEGRAM_BOT_TOKEN
./deploy.sh start          # build Docker image + launch
```

Or use the interactive menu:
```bash
./deploy.sh
```

---

## 🗺 Deploy Script

| Command | Description |
|---|---|
| `./deploy.sh setup` | First-time install — copies .env, installs deps, auto-generates secret |
| `./deploy.sh rpc` | Provision a Solana RPC via Helius/QuickNode/public wizard |
| `./deploy.sh start` | Build Docker image + start production (bot + Redis) |
| `./deploy.sh dev` | Dev mode with hot-reload |
| `./deploy.sh stop` | Stop all containers |
| `./deploy.sh restart` | Restart bot only (no rebuild) |
| `./deploy.sh logs` | Tail live logs |
| `./deploy.sh update` | git pull + rebuild + restart |
| `./deploy.sh status` | Container health, uptime, resource usage |
| `./deploy.sh railway` | One-command deploy to Railway cloud |
| `./deploy.sh backup` | Backup Redis data to ./backups/ |
| `./deploy.sh clean` | Remove containers, images, volumes |

---

## ☁️ Deploy to Railway

```bash
./deploy.sh railway
```

Automatically installs Railway CLI, provisions Redis, syncs env vars, and deploys via Dockerfile.

---

## ✨ Features

| Feature | Command |
|---|---|
| Buy tokens | `/buy <address> [amount]` |
| Sell tokens | `/sell <address> [percent]` |
| Sniper (auto-buy launches) | `/sniper` |
| Copy trading | `/copy <wallet>` |
| Take Profit / Stop Loss | `/settp` `/setsl` |
| Limit orders | `/buylimit` `/selllimit` |
| Safety scanner (rug/honeypot) | `/safety <address>` |
| Portfolio P&L dashboard | `/portfolio` |
| Referral system | `/refer` |
| Trending tokens + signals | `/trends` |
| Multi-chain (Solana + ETH) | `/settings` → Switch Chain |

---

## 🏗 Architecture

```
src/
├── index.ts
├── bot/bot.ts                       # All Telegram commands
├── chains/
│   ├── ChainPlugin.ts               # Interface for all chains
│   ├── registry.ts                  # Plugin registry
│   ├── solana/SolanaPlugin.ts       # Jupiter swaps + Pump.fun sniper
│   └── ethereum/EthereumPlugin.ts   # Uniswap V3
└── services/
    ├── UserService.ts               # Redis-backed wallets & settings
    ├── SniperService.ts             # Launch detection + auto-buy
    ├── CopyTradeService.ts          # Wallet mirroring
    ├── PriceMonitorService.ts       # TP/SL polling
    ├── LimitOrderService.ts         # Price-target orders
    ├── TokenSafetyService.ts        # Rug/honeypot scanner
    ├── ReferralService.ts           # Referral earnings
    ├── PortfolioService.ts          # P&L tracking
    └── TrendsService.ts             # DexScreener signals
```

Adding a new chain: implement `ChainPlugin`, call `registerChain(new MyPlugin())` — all features work automatically.

---

## 🔒 Security

- Private keys encrypted with AES-256-GCM
- Non-root Docker user
- Redis AOF persistence
- Safety scanner blocks CRITICAL-risk tokens before buys

---

> ⚠️ Trading meme tokens carries extreme financial risk. Use at your own risk.
