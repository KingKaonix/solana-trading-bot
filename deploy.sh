#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  deploy.sh — Solana Trading Bot — One-script build & deploy
#
#  Usage:
#    ./deploy.sh                  → interactive menu
#    ./deploy.sh setup            → first-time setup (install deps, configure .env)
#    ./deploy.sh dev              → run locally with hot-reload (Docker)
#    ./deploy.sh start            → build & start production (Docker)
#    ./deploy.sh stop             → stop all containers
#    ./deploy.sh restart          → restart bot container only
#    ./deploy.sh logs             → tail bot logs
#    ./deploy.sh update           → pull latest code + rebuild + restart
#    ./deploy.sh rpc              → run the RPC provisioner wizard
#    ./deploy.sh railway          → deploy to Railway (cloud)
#    ./deploy.sh status           → show container health & uptime
#    ./deploy.sh backup           → backup Redis data
#    ./deploy.sh clean            → remove containers, images, volumes
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}✔${RESET}  $*"; }
err()  { echo -e "${RED}✘${RESET}  $*"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $*"; }
info() { echo -e "${CYAN}→${RESET}  $*"; }
head() { echo -e "\n${BOLD}${CYAN}$*${RESET}\n"; }
dim()  { echo -e "${DIM}$*${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Requirement checks ────────────────────────────────────────────────────────
check_deps() {
  local missing=()
  command -v docker   &>/dev/null || missing+=("docker")
  command -v node     &>/dev/null || missing+=("node")
  command -v npm      &>/dev/null || missing+=("npm")

  if [ ${#missing[@]} -ne 0 ]; then
    err "Missing required tools: ${missing[*]}"
    echo ""
    echo "  Install Docker:  https://docs.docker.com/get-docker/"
    echo "  Install Node 20: https://nodejs.org/"
    exit 1
  fi

  # Docker running?
  if ! docker info &>/dev/null; then
    err "Docker daemon is not running. Start Docker Desktop or: sudo systemctl start docker"
    exit 1
  fi

  ok "All dependencies present"
}

# ── .env guard ────────────────────────────────────────────────────────────────
check_env() {
  if [ ! -f ".env" ]; then
    warn ".env file not found."
    if [ -f ".env.example" ]; then
      cp .env.example .env
      warn "Created .env from .env.example — please fill in your values."
      echo ""
      echo "  Required:"
      echo "    TELEGRAM_BOT_TOKEN  → get from @BotFather on Telegram"
      echo "    SOLANA_RPC_URL      → run: ./deploy.sh rpc"
      echo "    WALLET_ENCRYPTION_SECRET → any 32+ character random string"
      echo ""
      echo "  Then rerun: ./deploy.sh start"
    fi
    exit 1
  fi

  # Check critical vars
  local missing_vars=()
  # shellcheck disable=SC1091
  source .env 2>/dev/null || true

  [ -z "${TELEGRAM_BOT_TOKEN:-}" ]        && missing_vars+=("TELEGRAM_BOT_TOKEN")
  [ -z "${SOLANA_RPC_URL:-}" ]            && missing_vars+=("SOLANA_RPC_URL")
  [ -z "${WALLET_ENCRYPTION_SECRET:-}" ]  && missing_vars+=("WALLET_ENCRYPTION_SECRET")

  if [ ${#missing_vars[@]} -ne 0 ]; then
    err "Missing required .env variables:"
    for v in "${missing_vars[@]}"; do
      echo "    • $v"
    done
    echo ""
    echo "  Edit .env and fill in the missing values."
    echo "  For SOLANA_RPC_URL run: ./deploy.sh rpc"
    exit 1
  fi

  ok ".env looks good"
}

# ── Setup ─────────────────────────────────────────────────────────────────────
cmd_setup() {
  head "🛠  First-Time Setup"

  check_deps

  # Copy .env
  if [ ! -f ".env" ]; then
    cp .env.example .env
    ok "Created .env from template"
  else
    ok ".env already exists"
  fi

  # Install node deps
  info "Installing npm dependencies..."
  npm ci
  ok "npm dependencies installed"

  # Generate encryption secret if missing
  # shellcheck disable=SC1091
  source .env 2>/dev/null || true
  if [ -z "${WALLET_ENCRYPTION_SECRET:-}" ] || [ "${WALLET_ENCRYPTION_SECRET}" = "change_this_to_a_long_random_string_32chars" ]; then
    SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    # Update in .env
    if grep -q "WALLET_ENCRYPTION_SECRET=" .env; then
      sed -i.bak "s|WALLET_ENCRYPTION_SECRET=.*|WALLET_ENCRYPTION_SECRET=${SECRET}|" .env && rm -f .env.bak
    else
      echo "WALLET_ENCRYPTION_SECRET=${SECRET}" >> .env
    fi
    ok "Generated WALLET_ENCRYPTION_SECRET → saved to .env"
  fi

  echo ""
  warn "Next steps:"
  echo "  1. Edit .env → set TELEGRAM_BOT_TOKEN (from @BotFather)"
  echo "  2. Run:  ./deploy.sh rpc   (provision a Solana RPC endpoint)"
  echo "  3. Run:  ./deploy.sh start  (build & launch)"
}

# ── RPC provisioner ───────────────────────────────────────────────────────────
cmd_rpc() {
  head "🔌  Solana RPC Provisioner"
  check_deps

  if ! command -v npx &>/dev/null; then
    err "npx not found. Install Node.js 20+."
    exit 1
  fi

  if [ ! -d "node_modules" ]; then
    info "Installing dependencies first..."
    npm ci
  fi

  npx ts-node scripts/provision-rpc.ts "$@"
}

# ── Build (local, no Docker) ──────────────────────────────────────────────────
cmd_build() {
  head "🔨  Building TypeScript"
  npm run build
  ok "Build complete → dist/"
}

# ── Dev mode (Docker, hot-reload) ─────────────────────────────────────────────
cmd_dev() {
  head "🔥  Development Mode (hot-reload)"
  check_deps
  check_env

  info "Starting bot + Redis in dev mode..."
  docker compose \
    -f docker-compose.yml \
    -f docker-compose.dev.yml \
    up --build

}

# ── Production start ──────────────────────────────────────────────────────────
cmd_start() {
  head "🚀  Starting Production Bot"
  check_deps
  check_env

  info "Building Docker image..."
  docker compose build --no-cache bot
  ok "Image built"

  info "Starting services (bot + Redis)..."
  docker compose up -d
  ok "Services started"

  # Wait for bot to be healthy
  info "Waiting for bot to start..."
  sleep 3

  # Show status
  cmd_status

  echo ""
  ok "Bot is running! Check logs with: ./deploy.sh logs"
}

# ── Stop ──────────────────────────────────────────────────────────────────────
cmd_stop() {
  head "🛑  Stopping Bot"
  docker compose down
  ok "All containers stopped"
}

# ── Restart bot only ──────────────────────────────────────────────────────────
cmd_restart() {
  head "🔄  Restarting Bot"
  docker compose restart bot
  ok "Bot restarted"
  sleep 2
  cmd_status
}

# ── Logs ──────────────────────────────────────────────────────────────────────
cmd_logs() {
  local lines="${1:-100}"
  docker compose logs --tail="$lines" -f bot
}

# ── Update ────────────────────────────────────────────────────────────────────
cmd_update() {
  head "⬆️   Updating Bot"

  # Git pull if in a git repo
  if [ -d ".git" ]; then
    info "Pulling latest code..."
    git pull
    ok "Code updated"
  else
    warn "Not a git repo — skipping git pull"
  fi

  info "Rebuilding image..."
  docker compose build --no-cache bot
  ok "Image rebuilt"

  info "Restarting bot..."
  docker compose up -d bot
  ok "Bot restarted with new code"

  sleep 3
  cmd_status
}

# ── Status ────────────────────────────────────────────────────────────────────
cmd_status() {
  head "📊  Service Status"

  echo -e "  ${BOLD}Container Status:${RESET}"
  docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || \
    docker compose ps

  echo ""
  echo -e "  ${BOLD}Resource Usage:${RESET}"
  docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" \
    trading-bot trading-bot-redis 2>/dev/null || true

  echo ""
  # Show last 5 log lines
  echo -e "  ${BOLD}Recent Logs:${RESET}"
  docker compose logs --tail=5 bot 2>/dev/null | sed 's/^/  /' || true
}

# ── Backup Redis data ─────────────────────────────────────────────────────────
cmd_backup() {
  head "💾  Backing Up Redis Data"
  local timestamp
  timestamp=$(date +%Y%m%d_%H%M%S)
  local backup_dir="./backups"
  mkdir -p "$backup_dir"

  # Trigger Redis BGSAVE
  docker compose exec redis redis-cli BGSAVE 2>/dev/null || true
  sleep 2

  # Copy dump.rdb out
  docker cp trading-bot-redis:/data/dump.rdb "${backup_dir}/redis_${timestamp}.rdb" 2>/dev/null || {
    warn "Could not copy RDB — using docker volume export"
    docker run --rm \
      -v "$(basename "$SCRIPT_DIR")_redis_data":/data \
      -v "${SCRIPT_DIR}/${backup_dir}":/backup \
      alpine tar czf "/backup/redis_${timestamp}.tar.gz" /data
  }

  ok "Backup saved to ${backup_dir}/redis_${timestamp}.rdb"
}

# ── Railway deploy ────────────────────────────────────────────────────────────
cmd_railway() {
  head "🚂  Deploy to Railway"

  if ! command -v railway &>/dev/null; then
    info "Installing Railway CLI..."
    npm install -g @railway/cli
  fi

  check_env

  info "Logging in to Railway..."
  railway login

  # Check if project exists
  if ! railway status &>/dev/null; then
    info "Initialising new Railway project..."
    railway init
  fi

  # Provision Redis if not already done
  info "Ensuring Redis plugin is provisioned..."
  railway add --plugin redis 2>/dev/null || warn "Redis may already be provisioned"

  # Push env vars to Railway
  info "Syncing .env variables to Railway..."
  # shellcheck disable=SC1091
  source .env
  while IFS= read -r line; do
    # Skip comments and empty lines
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
    key="${line%%=*}"
    val="${line#*=}"
    # Skip REDIS_URL — Railway provides it automatically
    [ "$key" = "REDIS_URL" ] && continue
    railway variables set "${key}=${val}" 2>/dev/null || true
  done < .env
  ok "Environment variables synced"

  # Deploy
  info "Deploying to Railway..."
  railway up --detach
  ok "Deployed! Check status with: railway logs"

  echo ""
  echo "  View your bot: railway open"
  echo "  View logs:     railway logs"
}

# ── Clean ─────────────────────────────────────────────────────────────────────
cmd_clean() {
  head "🧹  Cleaning Up"

  warn "This will remove containers, images, and volumes."
  read -rp "  Are you sure? (yes/no): " confirm
  if [ "$confirm" != "yes" ]; then
    info "Aborted."
    exit 0
  fi

  docker compose down -v --rmi all --remove-orphans 2>/dev/null || true
  ok "Containers, images, and volumes removed"

  if [ -d "dist" ]; then
    rm -rf dist
    ok "dist/ removed"
  fi
}

# ── Interactive menu ──────────────────────────────────────────────────────────
cmd_menu() {
  echo ""
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════╗"
  echo -e "║    🤖  Solana Trading Bot Deploy         ║"
  echo -e "╚══════════════════════════════════════════╝${RESET}"
  echo ""
  echo -e "  ${GREEN}1.${RESET} setup      — First-time install & configure"
  echo -e "  ${GREEN}2.${RESET} rpc        — Provision Solana RPC endpoint"
  echo -e "  ${GREEN}3.${RESET} start      — Build & start (production)"
  echo -e "  ${GREEN}4.${RESET} dev        — Start in dev mode (hot-reload)"
  echo -e "  ${GREEN}5.${RESET} stop       — Stop all services"
  echo -e "  ${GREEN}6.${RESET} restart    — Restart bot only"
  echo -e "  ${GREEN}7.${RESET} logs       — Tail live logs"
  echo -e "  ${GREEN}8.${RESET} update     — Pull + rebuild + restart"
  echo -e "  ${GREEN}9.${RESET} status     — Container health & uptime"
  echo -e "  ${GREEN}10.${RESET} railway   — Deploy to Railway cloud"
  echo -e "  ${GREEN}11.${RESET} backup    — Backup Redis data"
  echo -e "  ${GREEN}12.${RESET} clean     — Remove everything (danger)"
  echo ""
  read -rp "  Choose [1-12]: " choice
  echo ""

  case "$choice" in
    1) cmd_setup ;;
    2) cmd_rpc ;;
    3) cmd_start ;;
    4) cmd_dev ;;
    5) cmd_stop ;;
    6) cmd_restart ;;
    7) cmd_logs ;;
    8) cmd_update ;;
    9) cmd_status ;;
    10) cmd_railway ;;
    11) cmd_backup ;;
    12) cmd_clean ;;
    *) err "Invalid choice: $choice" ;;
  esac
}

# ── Entrypoint ────────────────────────────────────────────────────────────────
CMD="${1:-menu}"
shift || true

case "$CMD" in
  setup)    cmd_setup ;;
  rpc)      cmd_rpc "$@" ;;
  build)    cmd_build ;;
  dev)      cmd_dev ;;
  start)    cmd_start ;;
  stop)     cmd_stop ;;
  restart)  cmd_restart ;;
  logs)     cmd_logs "${1:-100}" ;;
  update)   cmd_update ;;
  status)   cmd_status ;;
  railway)  cmd_railway ;;
  backup)   cmd_backup ;;
  clean)    cmd_clean ;;
  menu)     cmd_menu ;;
  *)
    err "Unknown command: $CMD"
    echo ""
    echo "Usage: ./deploy.sh [setup|rpc|start|dev|stop|restart|logs|update|status|railway|backup|clean]"
    exit 1
    ;;
esac
