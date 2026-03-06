# Running in GitHub Codespaces

No local install needed. Everything runs in the browser.

---

## 1. Open in Codespaces

On your GitHub repo page:

```
Code → Codespaces → Create codespace on main
```

Or use this URL pattern:
```
https://codespaces.new/<your-username>/<your-repo>
```

The environment will auto-build (~2 min first time):
- Node 20 installed
- `npm ci` runs automatically
- `.env` created from template
- `WALLET_ENCRYPTION_SECRET` auto-generated

---

## 2. Set your Telegram token

In the Codespaces terminal:

```bash
# Open .env in the editor
code .env
```

Set:
```env
TELEGRAM_BOT_TOKEN=your_token_from_botfather
```

Get a token: open Telegram → search `@BotFather` → `/newbot`

---

## 3. Provision a Solana RPC

```bash
./deploy.sh rpc
```

This runs the interactive wizard and writes `SOLANA_RPC_URL` to `.env` automatically.  
Recommended: choose **Helius** (free, 100k credits/day).

---

## 4. Start the bot

```bash
npm run dev
```

You'll see:
```
✅ @YourBot is live — all systems go 🚀
```

The bot is now live on Telegram. Hot-reload is active — save any `.ts` file and it restarts instantly.

---

## Ports

| Port | Service | Auto-forwarded |
|---|---|---|
| 3000 | Bot (health endpoint) | Silent |
| 8081 | Redis UI (debug) | Silent |

To open Redis UI: go to the **Ports** tab in VS Code → click port 8081.

---

## Tips

**Persist your .env across rebuilds:**  
Codespaces stores the workspace on a persistent disk, so `.env` survives rebuilds automatically.

**Stop the bot:**  
`Ctrl+C` in the terminal, or close the Codespace. Your Redis data persists.

**Secrets (recommended for team use):**  
Instead of putting secrets in `.env`, use Codespaces Secrets:
```
GitHub → Settings → Codespaces → New secret
```
Add `TELEGRAM_BOT_TOKEN`, `SOLANA_RPC_URL`, `WALLET_ENCRYPTION_SECRET`.  
They're injected automatically as environment variables.

**Rebuilding the container:**  
```
Ctrl+Shift+P → Codespaces: Rebuild Container
```

---

## File structure added

```
.devcontainer/
└── devcontainer.json     ← Codespaces environment config
docker-compose.dev.yml    ← updated (ports exposed for Codespaces)
CODESPACES.md             ← this file
```

Everything else is unchanged — the same code runs locally and in Codespaces.
