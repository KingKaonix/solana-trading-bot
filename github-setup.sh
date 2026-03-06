#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  github-setup.sh
#  Creates a GitHub repo, uploads all bot files, configures Codespaces secrets,
#  and opens your Codespace — ready to run in one command.
#
#  Prerequisites:
#    - GitHub CLI (gh):  https://cli.github.com  or  brew install gh
#    - git
#    - node (for RPC provisioner, optional)
#
#  Usage:
#    chmod +x github-setup.sh
#    ./github-setup.sh
#
#  Or with flags (non-interactive):
#    ./github-setup.sh \
#      --repo my-trading-bot \
#      --token "tg_bottoken_here" \
#      --rpc "https://mainnet.helius-rpc.com/?api-key=KEY" \
#      --secret "my32charencryptionsecrethere1234" \
#      --private
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✔${RESET}  $*"; }
err()  { echo -e "${RED}✘  $*${RESET}"; exit 1; }
warn() { echo -e "${YELLOW}⚠${RESET}  $*"; }
info() { echo -e "${CYAN}→${RESET}  $*"; }
head() { echo -e "\n${BOLD}${CYAN}━━━  $*  ━━━${RESET}\n"; }
ask()  { echo -e "${BOLD}${CYAN}?${RESET}  $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Parse CLI flags ───────────────────────────────────────────────────────────
REPO_NAME=""
TG_TOKEN=""
RPC_URL=""
WS_URL=""
ENC_SECRET=""
VISIBILITY="public"   # public or private
SKIP_CODESPACE=false
SKIP_SECRETS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --repo)      REPO_NAME="$2";    shift 2 ;;
    --token)     TG_TOKEN="$2";     shift 2 ;;
    --rpc)       RPC_URL="$2";      shift 2 ;;
    --ws)        WS_URL="$2";       shift 2 ;;
    --secret)    ENC_SECRET="$2";   shift 2 ;;
    --private)   VISIBILITY="private"; shift ;;
    --no-codespace) SKIP_CODESPACE=true; shift ;;
    --no-secrets)   SKIP_SECRETS=true;   shift ;;
    *) warn "Unknown flag: $1"; shift ;;
  esac
done

# ══════════════════════════════════════════════════════════════════════════════
# STEP 0 — Banner + prereq check
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗"
echo -e "║   🤖  Solana Bot — GitHub + Codespaces Setup  ║"
echo -e "╚══════════════════════════════════════════════╝${RESET}"
echo ""

# Check git
command -v git &>/dev/null || err "git not found. Install from https://git-scm.com/"
ok "git $(git --version | awk '{print $3}')"

# Check gh CLI
if ! command -v gh &>/dev/null; then
  echo ""
  err "GitHub CLI (gh) not found.

  Install it:
    macOS:   brew install gh
    Linux:   https://github.com/cli/cli/blob/trunk/docs/install_linux.md
    Windows: winget install GitHub.cli

  Then rerun this script."
fi
ok "gh $(gh --version | head -1 | awk '{print $3}')"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 1 — GitHub auth
# ══════════════════════════════════════════════════════════════════════════════
head "Step 1 — GitHub Authentication"

if ! gh auth status &>/dev/null; then
  info "Not logged in to GitHub. Starting login..."
  echo ""
  gh auth login --web --git-protocol https
  echo ""
fi

GH_USER=$(gh api user --jq '.login')
ok "Logged in as: ${BOLD}${GH_USER}${RESET}"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 2 — Gather config (interactive if flags not provided)
# ══════════════════════════════════════════════════════════════════════════════
head "Step 2 — Configuration"

# Repo name
if [ -z "$REPO_NAME" ]; then
  ask "Repository name (default: solana-trading-bot):"
  read -r input
  REPO_NAME="${input:-solana-trading-bot}"
fi
# Sanitise: lowercase, hyphens
REPO_NAME=$(echo "$REPO_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')
ok "Repo name: ${BOLD}${GH_USER}/${REPO_NAME}${RESET}"

# Visibility
if [ "$VISIBILITY" = "public" ]; then
  ask "Make repo private? (y/N):"
  read -r vis_input
  [[ "$vis_input" =~ ^[Yy]$ ]] && VISIBILITY="private"
fi
ok "Visibility: ${VISIBILITY}"

# Telegram token
if [ -z "$TG_TOKEN" ] && [ "$SKIP_SECRETS" = false ]; then
  echo ""
  warn "You'll need a Telegram Bot Token from @BotFather."
  info "Open Telegram → search @BotFather → /newbot → follow steps."
  echo ""
  ask "Paste your TELEGRAM_BOT_TOKEN (or press Enter to skip and add later):"
  read -r TG_TOKEN
fi

# RPC URL
if [ -z "$RPC_URL" ] && [ "$SKIP_SECRETS" = false ]; then
  echo ""
  info "A Solana RPC URL is required for the bot to trade."
  info "Free options:"
  echo "    Helius (recommended): https://dev.helius.xyz/dashboard/app"
  echo "    QuickNode:            https://www.quicknode.com/"
  echo "    Public (slow):        https://api.mainnet-beta.solana.com"
  echo ""
  ask "Paste your SOLANA_RPC_URL (or Enter to use public fallback):"
  read -r RPC_URL
  RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"
  # Derive WS URL from RPC if not provided
  if [ -z "$WS_URL" ]; then
    WS_URL=$(echo "$RPC_URL" | sed 's|https://|wss://|' | sed 's|http://|ws://|')
  fi
fi

# Encryption secret
if [ -z "$ENC_SECRET" ] && [ "$SKIP_SECRETS" = false ]; then
  # Auto-generate a secure one
  if command -v node &>/dev/null; then
    ENC_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    ok "Auto-generated WALLET_ENCRYPTION_SECRET (32 bytes)"
  else
    ENC_SECRET=$(head -c 32 /dev/urandom | xxd -p | tr -d '\n')
    ok "Auto-generated WALLET_ENCRYPTION_SECRET"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 3 — Create GitHub repo
# ══════════════════════════════════════════════════════════════════════════════
head "Step 3 — Creating GitHub Repository"

REPO_FULL="${GH_USER}/${REPO_NAME}"

# Check if repo already exists
if gh repo view "$REPO_FULL" &>/dev/null; then
  warn "Repo ${REPO_FULL} already exists."
  ask "Push to existing repo? (y/N):"
  read -r overwrite
  if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
    info "Aborted."
    exit 0
  fi
else
  gh repo create "$REPO_NAME" \
    --${VISIBILITY} \
    --description "🤖 Solana Telegram trading bot — sniper, copy trade, TP/SL, multi-chain" \
    --clone=false
  ok "Repo created: https://github.com/${REPO_FULL}"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 4 — Initialise git and push files
# ══════════════════════════════════════════════════════════════════════════════
head "Step 4 — Pushing Files to GitHub"

cd "$SCRIPT_DIR"

# Init git if not already
if [ ! -d ".git" ]; then
  git init -b main
  ok "Git repo initialised"
else
  ok "Git repo already initialised"
fi

# Set remote
if git remote get-url origin &>/dev/null; then
  git remote set-url origin "https://github.com/${REPO_FULL}.git"
else
  git remote add origin "https://github.com/${REPO_FULL}.git"
fi
ok "Remote: https://github.com/${REPO_FULL}.git"

# Ensure .env is gitignored (never commit secrets)
if ! grep -q "^\.env$" .gitignore 2>/dev/null; then
  echo ".env" >> .gitignore
fi

# Stage all files
git add -A
git add -f .devcontainer/  # force-add hidden dir
git add -f .env.example
git add -f .gitignore
git add -f .dockerignore

# Commit
if git diff --cached --quiet; then
  ok "Nothing new to commit"
else
  git commit -m "🚀 Initial commit — Solana trading bot

Features:
- Buy/Sell via Jupiter aggregator
- Pump.fun sniper (auto-buy new launches)
- Copy trading (mirror any wallet)
- Take Profit / Stop Loss automation
- Limit orders
- Token safety scanner (rug/honeypot)
- Portfolio P&L dashboard
- Referral system
- Solana + Ethereum plugins
- Docker + Railway deploy
- GitHub Codespaces support"
  ok "Committed"
fi

# Push
info "Pushing to GitHub..."
git push -u origin main --force
ok "Code pushed to https://github.com/${REPO_FULL}"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 5 — Set Codespaces secrets
# ══════════════════════════════════════════════════════════════════════════════
if [ "$SKIP_SECRETS" = false ]; then
  head "Step 5 — Configuring Codespaces Secrets"

  set_secret() {
    local name="$1"
    local value="$2"
    if [ -n "$value" ]; then
      echo "$value" | gh secret set "$name" \
        --repo "$REPO_FULL" \
        --app codespaces 2>/dev/null && ok "Secret set: $name" \
        || warn "Could not set secret $name (you can add it manually in GitHub Settings)"
    else
      warn "Skipping $name — no value provided"
    fi
  }

  set_secret "TELEGRAM_BOT_TOKEN"       "$TG_TOKEN"
  set_secret "SOLANA_RPC_URL"           "$RPC_URL"
  set_secret "SOLANA_WS_URL"            "$WS_URL"
  set_secret "WALLET_ENCRYPTION_SECRET" "$ENC_SECRET"

  echo ""
  info "Secrets are stored encrypted in GitHub — never exposed in logs."
  info "View/edit at: https://github.com/${REPO_FULL}/settings/secrets/codespaces"
else
  warn "Skipping secrets (--no-secrets flag set)"
  warn "Add them manually: https://github.com/${REPO_FULL}/settings/secrets/codespaces"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 6 — Create and open Codespace
# ══════════════════════════════════════════════════════════════════════════════
if [ "$SKIP_CODESPACE" = false ]; then
  head "Step 6 — Launching Codespace"

  info "Creating Codespace (this takes ~60s on first run)..."
  echo ""

  CODESPACE_NAME=$(gh codespace create \
    --repo "$REPO_FULL" \
    --branch main \
    --machine "standardLinux32gb" \
    --display-name "trading-bot" \
    --status 2>/dev/null | tail -1)

  if [ -n "$CODESPACE_NAME" ]; then
    ok "Codespace created: ${BOLD}${CODESPACE_NAME}${RESET}"
    echo ""
    info "Opening in browser..."
    gh codespace code --codespace "$CODESPACE_NAME" --web
  else
    warn "Could not auto-create Codespace. Open it manually:"
    echo ""
    echo "  https://codespaces.new/${REPO_FULL}"
    echo ""
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# Done
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════╗"
echo -e "║   ✅  All done!                               ║"
echo -e "╚══════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Repo:${RESET}       https://github.com/${REPO_FULL}"
echo -e "  ${BOLD}Codespace:${RESET}  https://codespaces.new/${REPO_FULL}"
echo -e "  ${BOLD}Secrets:${RESET}    https://github.com/${REPO_FULL}/settings/secrets/codespaces"
echo ""
echo -e "  ${BOLD}Once inside the Codespace, run:${RESET}"
echo -e "  ${CYAN}  npm run dev${RESET}"
echo ""
echo -e "  ${DIM}Secrets are injected automatically as env vars.${RESET}"
echo -e "  ${DIM}Hot-reload is active — save any .ts file to restart.${RESET}"
echo ""
