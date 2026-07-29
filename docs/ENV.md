# Environment variables

All secrets are **server-side only** (Vercel Project -> Settings -> Environment
Variables, or a local `.env`). They are read by name, never committed, never
returned to the browser, and never written into the Kleegr manifest. Never put a
real secret value in this file, the repo, or the manifest.

## Database

| Variable | Purpose | Required | Safe default |
| --- | --- | --- | --- |
| `DATABASE_URL` | Neon / Postgres pooled connection string. The API and CLI scripts use the first present of the fallback list below. | Yes (production) | unset -> app falls back to browser `localStorage` |

Connection-string fallback order (first present wins), from `api/_lib/db.ts`:
`DATABASE_URL`, `POSTGRES_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_PRISMA_URL`,
`POSTGRES_URL_NON_POOLING`, `NEON_DATABASE_URL`. Set `DATABASE_URL` to the Neon
**pooled** string in production; `GET /api/health` reports which variable was
resolved.

## Kleegr Smart Productivity (GoHighLevel bridge)

| Variable | Purpose | Required | Safe default |
| --- | --- | --- | --- |
| `KLEEGR_API_BASE_URL` | Base URL of the Kleegr Smart Productivity API (token verify, launch verify, gateway reads, status reporting). | No | `https://smart-productivity-pied.vercel.app` (documented default in `api/_lib/kleegr.ts`) |
| `KLEEGR_INTEGRATION_TOKEN` | Server-to-Kleegr credential (Bearer) for `/api/integration/me`, status reporting, and manifest dry-run import. Launch/gateway calls hard-fail without it. | Yes (to connect) | unset -> integration reports "not configured" |
| `KLEEGR_WEBHOOK_SECRET` | HMAC-SHA256 secret used to verify inbound webhook signatures (`X-SP-Signature`). Verification fails closed: a missing secret returns HTTP 500. | Yes (for webhooks) | unset -> webhook route returns 500 |
| `KLEEGR_SYNC_ENABLED` | Master on/off gate for automatic Kleegr -> SCM import. Default off. See note below. | No | off (unset) |

**`KLEEGR_SYNC_ENABLED`.** This is the documented operator gate for automatic
import; leaving it unset (off) is the safe posture. As of this revision the
import automation is driven by the Kleegr **launch** flow (a best-effort initial
sync on `/kleegr/launch`) and by the admin-only `POST /api/kleegr/sync` (which
itself requires a fresh Kleegr launch token), rather than branching on this
variable. To guarantee no auto-import today, keep the sub-account disconnected at
Kleegr and/or omit `KLEEGR_INTEGRATION_TOKEN` (see `INCIDENT_RECOVERY.md`), and
treat `KLEEGR_SYNC_ENABLED=off` as the explicit forward-looking switch.

## Demo / Review mode

| Variable | Purpose | Required | Safe default |
| --- | --- | --- | --- |
| `DEMO_MODE` | Enables the no-password Review Mode bypass (tenant/role switcher). **Off by default.** Affirmative values: `1`, `true`, `on`, `enabled`, `yes`; anything else (including unset) keeps it off. | No | off (unset) -> login wall enforced |
| `DEMO_MODE_ALLOW_IN_PRODUCTION` | Second key required to allow the demo bypass in a Vercel **production** deployment. | No | off (unset) -> demo bypass impossible in production |

**How the guard works (`api/_lib/auth.ts`).** `demoModeEnabled()` returns false
unless `DEMO_MODE` is affirmative. Additionally, in a Vercel production
deployment (`VERCEL_ENV=production`) the bypass is forced off even if `DEMO_MODE`
is affirmative, unless `DEMO_MODE_ALLOW_IN_PRODUCTION` is also affirmative.
Turning the demo bypass on for a production URL is therefore a deliberate
two-key action and can never happen from a single stray env value. The bypass
only ever resolves an existing seeded demo user for the `demo` / `acme` tenants
(it never mints an identity), and a real password session always takes
precedence.

## AI (proposal / contract generation)

| Variable | Purpose | Required | Safe default |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | Server-side OpenAI key for `/api/ai` (proposal / contract / section / email generation). The key never reaches the browser. | No | unset -> AI generation returns `ai_not_configured` |

Additional variants read by `api/ai.ts` and `api/_lib/documents-core.ts`:
`OPENAI_KEY` (alias for the key) and `OPENAI_MODEL` (chat model; default
`gpt-4o-mini`).

## Platform-provided

| Variable | Purpose |
| --- | --- |
| `VERCEL_ENV` | Set automatically by Vercel (`production` / `preview` / `development`). Read by the demo-mode production guard. Do not set by hand. |

CLI-only: the seed script (`scripts/seed.ts`) also honors `RESET=1` (equivalent
to `--reset`) to wipe and reseed the demo tenants. Never set this against a
database holding real data.
