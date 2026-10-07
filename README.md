# Venture Stream

AI-powered sales prospect intelligence and opportunity management: **Discover → Research → Identify opportunities → Find decision makers → Qualify → Contact → Follow up → Convert → Measure**.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the stack, data model, anti-fabrication design and security notes.

## Run locally

Requirements: Node 22+ and Docker (for PostgreSQL).

```bash
cp .env.example .env        # then add OPENAI_API_KEY and TAVILY_API_KEY
npm install
npm run db:up               # starts Postgres on localhost:5433
npm run db:migrate
npm run dev                 # http://localhost:3000
```

Create an account at `/register` — you get a workspace with the default opportunity categories and **no data**. Use **Discover** to find real prospects (needs both API keys), or add one on **Prospects**.

Without the API keys the app still works for manual prospecting; discovery, research, outreach and the assistant show a clear "not configured" message.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run db:generate` | Generate a migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` |
| `npm test` | Vitest against a throwaway Postgres (`TEST_DATABASE_URL`) |
| `npm run test:all` | Typecheck + tests |

## Configuration

All configuration is environment variables; see `.env.example`. Secrets are server-side only.

## Deploy

```bash
docker build -t venture-stream .
docker compose -f docker-compose.prod.yml up -d   # needs .env.production and POSTGRES_PASSWORD
```

Put a TLS-terminating proxy in front and set `APP_URL` to the https origin. The container runs migrations then starts the web server and the background worker.
