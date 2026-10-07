# Venture Stream — architecture and decisions

## Requirements that drove the choices

Authenticated multi-user web app, relational data with strong integrity, server-side secrets, external search and LLM calls that can take tens of seconds, background processing, and a one-container production deployment. Desktop-first, information-dense UI. No dummy data anywhere.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | One language across UI, server and tests; types catch tenancy and schema mistakes early. |
| Web framework | Next.js (App Router) | Server components read data directly (no client fetching layer or duplicated API), server actions give authenticated mutations with built-in origin checking, and `output: "standalone"` gives a small production image. One deployable unit. |
| Database | PostgreSQL 16 | Real constraints, partial/functional indexes, `FOR UPDATE SKIP LOCKED` for the job queue, `jsonb` for evidence — no extra infrastructure needed (no Redis/queue broker). |
| ORM | Drizzle ORM + `postgres` driver, SQL migrations in `drizzle/` | Thin, typed, close to SQL. Migrations are plain SQL files applied at container start. |
| Auth | Own implementation: scrypt password hashes, random 256-bit session tokens stored as SHA-256 hashes in `sessions`, `httpOnly` `SameSite=Lax` cookie | Smallest attack surface for email+password; no third-party identity dependency. Swappable later behind `lib/auth.ts`. |
| Validation | zod | Every service input is parsed; model output is parsed too. |
| Styling | Hand-written CSS with custom properties (`globals.css`) | No CSS framework dependency; dark + yellow design tokens in one place. |
| Icons | `lucide-react` (only icon library) | |
| Search provider | Tavily behind `SearchProvider` (`lib/providers/search`) | Add a provider by implementing one interface and registering it in `getSearchProvider()`. |
| AI provider | OpenAI behind `AiProvider` (`lib/providers/ai`) | Same pattern; chat-completions with function calling. `OPENAI_BASE_URL` allows compatible gateways. |
| Background work | `jobs` table + in-process worker started from `instrumentation.ts` | Discovery and research take 10–60 s and must not run inside a request. SKIP LOCKED means any number of app replicas can run workers safely; set `WORKER_ENABLED=false` on web-only replicas. |
| Tests | Vitest against a real throwaway Postgres | The valuable behaviour (tenancy, aggregation, grounding) lives in SQL and services. |

Deliberately **not** added: Redis, a queue broker, a UI component library, a state-management library, an auth SaaS, an HTTP client library (native `fetch` with a hardened wrapper).

## Layout

```
src/db/                 schema.ts (single source of truth), migrate.ts, client
src/lib/services/       business logic. Every function takes a Scope {workspaceId, userId}
src/lib/research/       site inspection, research pipeline, discovery
src/lib/assistant/      read-only tools + the grounded chat loop
src/lib/providers/      search/ and ai/ adapters
src/lib/jobs/           queue + worker
src/lib/net/            SSRF-safe fetch
src/app/(auth)/         login, register
src/app/(app)/          authenticated pages
src/app/actions.ts      server actions (thin: auth → service → result)
src/app/api/assistant/  the only JSON API route
```

Rule: pages and actions never query tables directly for tenant data; they call a service with a `Scope`. Services always filter by `workspace_id`.

## Data model

`users`, `sessions`, `workspaces`, `workspace_members (owner|admin|member)`, `prospects`, `prospect_facts`, `opportunity_categories`, `opportunities`, `contacts`, `campaigns`, `campaign_prospects`, `deals`, `tasks`, `activities`, `notes`, `outreach_drafts`, `discovery_runs`, `ai_conversations`, `ai_messages`, `jobs`, `audit_log`.

- Every tenant table carries `workspace_id` with `ON DELETE CASCADE`; composite/unique indexes lead with it where lists are filtered.
- `prospects (workspace_id, domain)` is unique — discovery cannot create duplicates.
- Money is `bigint` minor units. Currency lives on the workspace.
- `opportunity_categories` is per-workspace reference data (seeded with the ten defaults at workspace creation) so categories can be added, renamed or deactivated without code changes. `opportunities` is unique per (prospect, category).
- `prospect_facts.provenance` is an enum: `sourced` (found in a source or observed on the site), `inferred` (AI inference with no cited source), `unknown` (looked for, not found). Unknown is stored explicitly so the UI can say so.
- `deals` copy `discovery_source` from the prospect at creation, so source attribution survives later edits. Campaign attribution is `deals.campaign_id` (defaulting to the prospect's campaign if it has exactly one).
- `ai_conversations`/`ai_messages` persist chats per user; each assistant message records the records it surfaced (`entities`) so follow-ups such as "those" resolve.
- `audit_log` records security-relevant events (registration, login, membership changes).

## How "no invented data" is enforced (not just prompted)

1. **Site observations are computed, not generated.** `research/inspect.ts` fetches the homepage, `robots.txt`, `sitemap.xml`, `llms.txt` and derives facts from the markup (title, meta description, H1s, canonical, JSON-LD types, image alt coverage, platform/tech signatures).
2. **The model only sees gathered material** and must cite it. Opportunity evidence has to reference a real observation key or a supplied source id; `verifyEvidence` drops anything else, and opportunities with no verified evidence are discarded.
3. **Scores are capped by evidence**: `min(modelScore, 25 + 15 × verifiedEvidence, 95)`. Thin evidence can never yield a high score. The prospect score is derived from its stored, non-dismissed opportunities.
4. **People are verified against sources**: name and job title must literally appear in the cited source, the company must be mentioned there, emails are kept only if literally present in the source text, LinkedIn URLs only if literally present or the source itself is the profile. No email is ever constructed.
5. **Discovery candidates are verified**: the company's domain must appear in the cited source's text/URL; publishers, directories and social networks are excluded.
6. **Outreach** is built only from stored opportunities and sourced observations, refuses to run on an unresearched prospect, and has no "sent" state (there is no sending integration).
7. **The assistant answers via read-only tools** (parameterised service calls, workspace-scoped; no raw SQL from the model). The system prompt contains the exact fallback sentences. After generation, every markdown link is checked against the records retrieved in this conversation; unknown links are stripped to plain text.
8. **Empty states everywhere**; the dashboard/report numbers are aggregates over stored rows. There is no seeder.

## Security summary

- Secrets only in server env (`.env`, never committed); read through `lib/env.ts`; no `NEXT_PUBLIC_*` variables exist. `server-only` guards `lib/auth.ts`/`lib/api.ts`.
- Authorisation is checked server-side on every page, action and API route (`requireContext`), membership verified against the DB each request; proxy cookie check is only an optimistic redirect.
- Tenant isolation: every service query filters on `workspace_id`; foreign ids (assignee, campaign, opportunity, contact, draft) are re-validated against the workspace. Covered by tests.
- Passwords: scrypt (N=16384) with per-user salt; constant-time compare; equalised timing for unknown emails; sign-in throttling per IP+email and per email.
- Sessions: 256-bit random tokens, stored hashed, 14-day expiry, deleted on sign-out, `httpOnly`, `SameSite=Lax`, `Secure` over https.
- CSRF: server actions use Next's origin check; the JSON route additionally calls `assertSameOrigin`.
- SSRF: all server-side fetching of prospect sites goes through `safeFetchText` (public-IP check on every redirect hop, size/time caps). Note: a DNS-rebinding race between check and connect is theoretically possible; run the app in a network without access to internal services (egress filtering) for defence in depth.
- XSS: React escaping; the assistant markdown renderer emits only elements it builds and links only to in-app paths; external links are filtered to `http(s)` and use `rel="noopener noreferrer"`. CSP, HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` are set.
- Prompt injection: scraped web text is untrusted. The models cannot take actions (assistant tools are read-only; research output is validated and stored as data; outreach is draft-only), so injected instructions cannot exfiltrate data or modify records beyond what the validators allow.
- Errors: `AppError` carries user-safe text; anything else is logged server-side and shown as a generic message. Provider failures map to timeout / auth / rate-limit / API / invalid / empty / network.
- Known limits: the login throttle is in-process (use a shared limiter at the proxy for multi-replica deployments); open registration can be closed with `ALLOW_REGISTRATION=false`.

## Performance

- Server-side pagination (default 25, max 100) and filtering on indexed columns; list queries select only displayed columns; board shows top 30 per stage with counts.
- Verified by `tests/performance.test.ts`: with 5,000 prospects, list/search/filter/board/dashboard/report queries each complete in well under 100 ms locally.
- Search uses `ILIKE` over a few columns — fine into the tens of thousands of rows; beyond ~100k add a `pg_trgm` GIN index.
- Search input is debounced (300 ms); AI calls are never repeated automatically; the assistant sends the model only tool results (capped rows/size), never the dataset; research runs once per request and results are stored.

## Deployment

`Dockerfile` builds a standalone image that applies migrations (`scripts/migrate.mjs`) and starts the server plus worker. `docker-compose.prod.yml` shows the app + Postgres. Provide `.env.production` (see `.env.example`), terminate TLS in front, and set `APP_URL` to the public https origin.
