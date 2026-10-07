# Test report

Run: `npm run test:all` → typecheck clean, **40 tests passing in 5 files** (real PostgreSQL 16, recreated per run).

## Automated coverage

| Area | What is proven |
|---|---|
| Tenancy | A workspace cannot read, move, delete, assign, task, campaign or query the assistant about another workspace's records; assistant conversations are private to their user; assigning a non-member is rejected. Team members added by email gain access only to that workspace. |
| Prospects | Empty start; duplicate-domain rejection; URL validation; filtering (category, score, platform, stage, decision maker), sorting, pagination, wildcard escaping; bulk stage/assign; activity written for stage/note/contact. |
| Tasks | Today / upcoming / overdue / completed bucketing; completion timestamps; tasks surfaced under a prospect; foreign prospect rejected. |
| Revenue & campaigns | Campaign metrics, deal attribution (default to the prospect's only campaign), won-value required to win, source report, dashboard totals — all asserted against hand-computed expected numbers. Empty workspace reports zeros and empty arrays (no fabricated numbers). |
| Accounts | Registration validation, duplicate email (case-insensitive), authentication, unknown-email path, login throttling. |
| Research integrity | Site observations are derived from markup only; evidence pointing at non-existent observations/sources is dropped; scores are capped by verified evidence; sourced / inferred / unknown provenance is stored correctly; invented decision makers, unsupported titles, guessed emails and foreign-company people are rejected; discovery candidates whose domain is not in the cited source or that are publishers are rejected. |
| Failure handling | Research/discovery failures mark the record failed with a user-safe message; rate-limited jobs retry then fail; Tavily and OpenAI adapters map auth failure, rate limit, API error, invalid JSON, empty response, network failure and timeout to typed errors; invalid model JSON is retried once then reported safely. |
| SSRF | Loopback, private, link-local, ULA and IPv4-mapped addresses and non-http schemes are blocked. |
| AI assistant | Tool loop through the real OpenAI adapter against a local wire-format server and live database rows; grounding rules and exact fallback sentences are in the system prompt; fabricated links are stripped; the follow-up turn receives the prior records so "those" resolves; tool results never include another workspace's data. |
| Outreach | Refuses unresearched prospects; model input contains only stored facts; drafts have no "sent" state. |
| Scale | 5,000 prospects: list ≈40 ms, search ≈5 ms, filtered page ≈10 ms, pipeline board ≈55 ms, dashboard ≈10 ms, reports ≈25 ms (local). |

LLM and web-search responses in the automated tests come from scripted test doubles or a local server; they exist only in `tests/` and nothing in the application ships fake data or responses.

## Manual verification performed

- Production build and standalone Docker image build; container starts, applies migrations and serves `/login`.
- In a browser against the production build: registration → empty dashboard; every page renders in its empty state; manual prospect creation, task creation, stage change, assistant panel open/suggestions/error path/close; research without keys fails with the "not configured" message and the worker records it; security headers (CSP, HSTS, etc.) present and the app still hydrates under the CSP.
- The development database was emptied afterwards (no seed or sample data is created by the app).

## Not verified — be aware

- **No live OpenAI or Tavily calls were made** (no API keys were available). Adapters were tested against a local server speaking the same wire formats, but real-world response quirks, the default model name (`OPENAI_MODEL=gpt-5-mini`) and result quality for discovery/research are unproven until keys are added. Try Discover and the assistant with real keys first.
- **No visual/responsive review.** Screenshots timed out in this environment, so layout at laptop/tablet/mobile widths and the full-screen mobile assistant were implemented to the CSS spec but not seen. Do a visual pass.
- The login throttle is per process; drag-and-drop on the pipeline board was not exercised in a browser (stage menu path was).
- No browser-driven end-to-end suite exists yet; UI flows are covered manually and through service tests.
