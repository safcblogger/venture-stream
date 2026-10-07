#!/usr/bin/env bash
# One-command setup/update for a Docker-enabled Ubuntu server.
#   curl -fsSL https://raw.githubusercontent.com/safcblogger/venture-stream/master/scripts/deploy.sh | bash
# Re-run the same command later to update to the latest code. Existing settings are kept.
set -euo pipefail

REPO="https://github.com/safcblogger/venture-stream.git"
DIR="/opt/venture-stream"
DEFAULT_DOMAIN="vs.cultureddigital.co.uk"

command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR"

ask() { # ask VAR "prompt" [secret]
  local v
  if [ "${3:-}" = "secret" ]; then read -r -s -p "$2" v </dev/tty; echo; else read -r -p "$2" v </dev/tty; fi
  printf '%s' "$v"
}

if [ ! -f .env ]; then
  DOMAIN="$(ask DOMAIN "Domain [$DEFAULT_DOMAIN]: ")"; DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
  PGPASS="$(openssl rand -hex 24)"
  printf 'POSTGRES_PASSWORD=%s\nDOMAIN=%s\n' "$PGPASS" "$DOMAIN" > .env
  chmod 600 .env
fi

if [ ! -f .env.production ]; then
  # shellcheck disable=SC1091
  . ./.env
  echo "Paste your keys (input is hidden). Press Enter to skip one and add it later."
  OPENAI="$(ask OPENAI "OpenAI API key: " secret)"
  TAVILY="$(ask TAVILY "Tavily API key: " secret)"
  cat > .env.production <<ENV
APP_URL=https://$DOMAIN
AI_PROVIDER=openai
OPENAI_API_KEY=$OPENAI
OPENAI_MODEL=gpt-5-mini
SEARCH_PROVIDER=tavily
TAVILY_API_KEY=$TAVILY
ALLOW_REGISTRATION=true
WORKER_ENABLED=true
ENV
  chmod 600 .env.production
fi

docker compose -f docker-compose.prod.yml up -d --build
# shellcheck disable=SC1091
. ./.env
echo
echo "Done. Open https://$DOMAIN (the padlock can take a minute, and needs the DNS record to be live)."
