# Connected operations release - 2026-09-10

This release extends the existing Sales Tracker without replacing its records or existing features. It is a testable integration release, not a claim of complete GoHighLevel parity or provider activation.

## Implemented
- Smart Productivity service-key read gateway: users, contacts, opportunities, payments, funnels, forms, surveys and calendars. OAuth tokens stay in Smart Productivity. Commission Manager has no direct fallback when gateway routing is enabled.
- Source connections for funnels, websites, stores, forms, surveys and calendars. Per-source credentials, rotation, delivery verification, referral evidence, deduplicated review inbox and exact receipt/refund posting.
- Signed Stripe charge/refund capture, test/live separation and live subscription-event churn cohorts. Captured money events require reviewed local identity and product mapping before posting.
- PayPal Payouts adapter with separate sandbox/live gates, approved payout requirements, recipient/amount validation, durable unknown attempts and provider reconciliation. Sandbox transfers never settle live earnings.
- Daily operational alerts and future-enrollment welcome email queue; Resend sending is separately gated. Unknown deliveries cannot be blindly resent.
- Encrypted W-9/W-8BEN/W-8BEN-E PDF upload, scoped downloads and administrative review.
- Local read-only accountant login role with monthly PDF/CSV ZIP downloads. Connected GHL login roles remain managed upstream.
- Referral ancestors through level ten, month-end holds and audited manual-release holds.
- No-card commission/refund simulator using the production exact calculation engine, with no database records created.

## Verified
- 25 existing test suites and 46 existing tracker integration scenarios passed.
- 36 connected operations scenarios passed, including accountant API access, gateway fail-closed behavior, source/Stripe identities, encrypted tax access, exact refunds and mocked PayPal settlement.
- Eight isolated gateway contract checks passed.
- Live gateway reads succeeded for all eight supported resources in location qfbPEd8130ccGKpJuL8j. This proves reads, not an installed conversion workflow.
- Frontend/API typechecks and production build passed before release; final build and deployment are recorded in the release handoff.
- Local Chrome exercised the no-card simulator; report ZIP integrity and PDF rendering were checked.
- Database migration 0014 rehearsed on br-twilight-moon-ad70rpo4. Production snapshot: 2026-09-10 16:01:44 UTC, non-expiring. Migration applied to br-tiny-wind-adwktvs1.
- Production pre/post totals unchanged: 4310 clients, 25 people, 84 payments, 104 earnings, historical paid earning sum 10655.

## Activation and remaining scope
- Stripe account credentials and signing secret, PayPal provider credentials/recipient setup and verified email sender are not supplied. No live transfers or outgoing emails were executed.
- Production tax encryption key, cron secret and gateway flag were saved as server-only settings. Do not replace the tax key without migrating existing encrypted files.
- Confirm workspace currency/timezone, then publish real plans and assignments. No production currency assumption was applied.
- Install the referralClick custom field and authenticated workflow on each actual published source. A catalog entry or iframe is not full conversion tracking. End-to-end GHL checkout, cross-domain embeds and customer workflows remain activation tests.
- GHL builders are not recreated. The release connects existing published assets and trusted conversion events; it does not implement every GHL store/funnel/calendar management operation.
- Historical Stripe subscriptions require a reviewed backfill before churn is complete. Financial imports remain explicitly reviewed; no routine unattended import was enabled.
- Legacy financial migration must be assessed against the newer exact ledger schema; do not blindly apply obsolete legacy rule foreign keys to versioned rules.
- Monitor real provider delivery and deployment logs after activation; full multi-role/device live financial verification is not represented by isolated tests.

## Server settings
Production: KLEEGR_READ_GATEWAY_ENABLED=1; KLEEGR_TOKEN_SERVICE_KEY uses the existing service connection; TRACKER_TAX_ENCRYPTION_KEY is a secret 64-character hex value; CRON_SECRET is independently generated.
For Stripe: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, TRACKER_STRIPE_ACCOUNT_ID, then verify the account in Connections and register /api/stripe-events.
For email: RESEND_API_KEY, TRACKER_EMAIL_FROM and TRACKER_EMAIL_ENABLED=1, then opt in to notifications in Connections.
For PayPal: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, TRACKER_PAYPAL_TENANT_ID and TRACKER_PAYPAL_MODE=sandbox first. Live requires TRACKER_PAYPAL_MODE=live plus TRACKER_PAYOUTS_ENABLED=1 and an explicit approved-payout submission.
Never place these credentials in browser JavaScript, public URLs or committed files.
