# Kleegr Smart Productivity integration

Sales Commission Manager (SCM) connects to GoHighLevel **only through Kleegr
Smart Productivity**, a white-label bridge. There is **no direct GoHighLevel
OAuth, API call, or webhook** anywhere in this codebase: Kleegr owns the
GoHighLevel layer and SCM authenticates to Kleegr by token name only. All Kleegr
secrets are read server-side and are never logged, returned to the browser, or
placed in the manifest.

## Manifest

The canonical manifest is `smart-productivity.app.json` at the repo root; a
byte-identical typed copy lives in `api/_lib/kleegr-manifest.ts` (a unit test
asserts the two never drift). It contains no secrets -- only env-var **names**
appear (in `setupInstructions`).

- `appKey`: `sales-commission-manager`
- `launchUrl`: `.../kleegr/launch`
- `apiUrl`: `.../api/kleegr`
- `webhookUrl`: `.../api/kleegr/webhook`
- `statusEndpoint`: `.../api/kleegr/status`
- `healthCheckEndpoint`: `.../api/health`
- `placements`: `agency`, `live`, `settings`, `app_launcher`

### Scopes (read-only)

`locations.readonly`, `users.readonly`, `contacts.readonly`,
`opportunities.readonly`. SCM never requests a write scope.

`api/kleegr/status.ts` maps each scope to the gateway resource it reads:

| Manifest scope | Gateway resource |
| --- | --- |
| `locations.readonly` | `subaccount` |
| `users.readonly` | `users` |
| `contacts.readonly` | `contacts` |
| `opportunities.readonly` | `opportunities` |

## Launch flow (`/kleegr/launch`)

Kleegr opens the app at `/kleegr/launch` (rewritten to the `/api/kleegr/launch`
serverless function by `vercel.json`) with a short-lived launch token
(`?token=...` or `Authorization: Bearer ...`). The handler:

1. Extracts the launch token.
2. Verifies it with Kleegr (`POST {base}/api/plugins/verify` with `{ token, appKey }`).
3. Validates the claims: `valid === true`, `aud === "sales-commission-manager"`, not expired, `sp_user_id` present, `sub_account_id` present.
4. Maps the Kleegr role to an SCM role (agency placement: `agency_admin` -> `owner`; sub-account placement: `agency_admin`/`admin` -> `admin`; `manager` -> `sales_manager`; `user` -> `salesperson`; unknown -> `salesperson`).
5. Upserts the tenant (sub-account) and the user, then mints SCM's own httpOnly session cookie (`SameSite=None; Secure`, since the app may be embedded).
6. Best-effort: runs a small first sync and reports `connected` back to Kleegr (neither blocks the launch).
7. Redirects into the correct workspace (`/agency`, `/`, or `/portal`).

The launch token is used **once** (verify plus the immediate gateway sync) and
is never cached, reused, persisted, or sent to the browser.

## Endpoints

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/kleegr/launch` | GET/POST | public (verifies launch token) | Launch / SSO (above). |
| `/api/kleegr/status` | GET | public + optional session | Config presence (env-var names only), manifest info, and (with a session) the tenant-scoped connection summary. Also the manifest `statusEndpoint`. |
| `/api/kleegr/webhook` | POST | HMAC signature | Signed event receiver (below). |
| `/api/kleegr/sync` | POST | owner/admin + fresh launch token | Manual first sync for the session's tenant. |
| `/api/kleegr/test-connection` | POST | owner/admin | Live server-to-Kleegr token verify. |
| `/api/kleegr/validate-manifest` | POST | owner/admin | Kleegr dry-run manifest import. |
| `/api/kleegr/report-status` | POST | owner/admin | Report status back to Kleegr. |

## Webhooks (`/api/kleegr/webhook`)

Kleegr signs every webhook with HMAC-SHA256 over the **raw request body** and
sends it as `X-SP-Signature: sha256=<hex>`. Verification **fails closed**:

- missing secret (`KLEEGR_WEBHOOK_SECRET` unset) -> HTTP 500 (server misconfig)
- missing or invalid signature -> HTTP 401
- valid signature -> the event is processed, HTTP 200

Events are recorded idempotently by delivery id (a duplicate delivery is
acknowledged, not re-applied). Handled events: `app.installed`,
`subaccount.connected`, `subaccount.disconnected`, `contact.created`,
`contact.updated`, `opportunity.created`, `opportunity.updated`. Unknown or
undeclared events are acknowledged (200) and ignored to avoid retries.

## Open questions for the Kleegr team

These are the places where SCM currently accepts multiple shapes defensively and
needs Kleegr to confirm the canonical contract.

1. **Gateway resource token: `subaccount` vs `locations`.** The manifest scope is
   `locations.readonly`, but the gateway resource SCM posts for the sub-account
   profile is `subaccount` (`declaredResources()` in `api/kleegr/status.ts`;
   `GatewayResource` in `api/_lib/kleegr.ts`). Which token does the gateway
   expect -- `subaccount` or `locations`?
2. **Webhook event names: `subaccount.*` vs `location.*`.** SCM declares and
   handles `subaccount.connected` / `subaccount.disconnected`. GoHighLevel's
   native vocabulary is `location.*`. Which prefix does Kleegr actually emit?
3. **Launch-token claim shape.** SCM reads (accepting both snake_case and
   camelCase): `aud` (expected `sales-commission-manager`), `sp_user_id` (or
   `user_id`), `sub_account_id` (or `subAccountId`), `location_id` (or
   `locationId`), `role`, `permissions`, `exp`, and `placement` (from the query
   string or the raw claims). Please confirm the exact claim names, the `role`
   vocabulary (`agency_admin` / `subaccount_admin` / `manager` / `user` /
   `viewer`), how `placement` is delivered, and whether a **company / agency id**
   is included.
4. **Webhook delivery-id field for idempotency.** SCM derives the delivery id
   from the first present of `id`, `eventId`, `webhookId`, `deliveryId` in the
   payload body. Which field is canonical, and is a dedicated delivery-id
   **header** available instead?
