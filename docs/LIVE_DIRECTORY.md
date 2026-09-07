# Live Team and Clients

Commission Manager reads users and contacts from the GoHighLevel location attached to the authenticated tenant. Browser-supplied location IDs are not used. Team records do not grant login or administrator access; commission roles, pay settings, and application permissions remain separate from GHL roles.

## Configuration

Set `KLEEGR_API_BASE_URL` to your Smart Productivity HTTPS origin and `KLEEGR_TOKEN_SERVICE_KEY` to the service key accepted by its token service. Keep the existing `KLEEGR_INTEGRATION_TOKEN`, webhook secret, and database configuration. These variables are server-only and must never use the `VITE_` prefix.

Smart Productivity must have `TOKEN_INSPECT_ENABLED=1`, the matching `TOKEN_INSPECT_KEY`, and a connected Marketplace installation with `users.readonly` and `contacts.readonly`. Its token resolver refreshes and persists expiring OAuth tokens. Commission Manager requests a fresh location token for every sync and never persists or returns raw OAuth values to the browser. A revoked installation still requires reconnection in Smart Productivity.

## Behavior

- Launch from the connected Smart Productivity sub-account to establish the tenant and session. A configured launch syncs that tenant's directory.
- Team and Clients automatically refresh when opened if the previous attempt is over five minutes old. Owners/admins can also use **Sync from GoHighLevel**.
- All user/contact pages are loaded before a resource is saved, with a safety ceiling of 10,000 records per resource. Incomplete pagination and provider failures are explicit errors; previous records remain available.
- Existing matching team identities retain their commission role, salary, plan, manager assignment, and financial history. Users removed from GHL are marked as no longer assigned. Imported contacts start with zero fees and subscription amounts; sync never invents revenue or overwrites manually entered financial terms.
- The old built-in Demo and Acme workspaces are archived only when their exact seed identifiers match and they have no Smart Productivity link. Linked and manually entered customer data is preserved. Demo seeding/reset/login bypass are disabled.
- Database reads never fall back to a shared browser snapshot. Revision checks reject a stale full-state save after a directory sync, so it cannot erase newly imported records.

## Verification

Run `npm test` and `npm run build`. The directory transport suite covers token expiry, wrong-location responses, safe error messages, tenant membership, and pagination. For a connected account, open Team and Clients, sync, verify the counts against GHL, refresh the page, and verify persistence. Repeating sync should update the same identities without duplicates.
