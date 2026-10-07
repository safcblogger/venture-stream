#!/usr/bin/env bash
# One-command setup/update for a Docker-enabled Ubuntu server.
#   curl -fsSL https://raw.githubusercontent.com/safcblogger/venture-stream/master/scripts/deploy.sh | bash
# Re-run the same command later to update to the latest code. Existing settings are kept.
# API keys (OpenAI, Tavily) are entered in the app under Settings -> Integrations, not here.
set -euo pipefail

REPO="https://github.com/safcblogger/venture-stream.git"
DIR="/opt/venture-stream"
DEFAULT_DOMAIN="vs.cultureddigital.co.uk"

command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR"

if [ ! -f .env ]; then
  read -r -p "Domain [$DEFAULT_DOMAIN]: " DOMAIN </dev/tty || DOMAIN=""
  DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
  printf 'POSTGRES_PASSWORD=%s\nDOMAIN=%s\n' "$(openssl rand -hex 24)" "$DOMAIN" > .env
  chmod 600 .env
fi

if [ ! -f .env.production ]; then
  # shellcheck disable=SC1091
  . ./.env
  cat > .env.production <<ENV
APP_URL=https://$DOMAIN
SECRETS_KEY=$(openssl rand -hex 32)
AI_PROVIDER=openai
SEARCH_PROVIDER=tavily
ALLOW_REGISTRATION=true
WORKER_ENABLED=true
ENV
  chmod 600 .env.production
fi

docker compose -f docker-compose.prod.yml up -d --build
# shellcheck disable=SC1091
. ./.env
echo
echo "Done. Open https://$DOMAIN and add your API keys under Settings -> Integrations."
