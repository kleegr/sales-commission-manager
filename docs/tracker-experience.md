# Sales Tracker interface update

The six main sections follow the inspected GoHighLevel Sales Tracker: Dashboard, Sales Commission Structure, Salesman, Payout, Media and Settings. Existing clients, opportunities, payments, ledger, reports, goals, documents, portals and integrations remain under More or the relevant section tabs. The owner lands in the current workspace. Backend authorization and workspace isolation remain intact.

Implemented: live dashboard and revenue chart, complete salesman table with real metrics, manual profile tabs, CSV upload/map/review/import, contact selection across search and pages, duplicate prevention, a three-step structure wizard with exact commission rules and atomic assignments, payout lifecycle tabs and settlement evidence, media folders and authenticated file uploads, default referral settings, portal welcome message and custom names.

Reference differences: this app provides its own hosted referral form and external referral click tracking. GHL's embedded funnels/store/forms/calendar and Stripe conversion integration are not copied integrations. External conversions still use the existing reviewed import workflow. Automatic welcome emails, automatic money transfers and W8/W9 tax-form collection are not enabled. No placeholder switches claim these services are working. CSV limit is 500 rows / 180 KB; hosted media supports PDF, PNG, JPEG and WebP up to 2 MB. Larger resources can be shared by HTTPS link.

Apply additive migration 0013_tracker_experience explicitly after backup; see scripts/migrate-experience.ts. It adds profiles, source-contact identities, preferences, folders and authenticated file storage. It never seeds demonstration records, converts historical money, changes existing commission rules or creates logins. Migration does not run during requests.

Validation: frontend and API type checks; 25 existing suites; 46 isolated integration scenarios including migration preservation, import scope/deduplication/rollback, structure atomicity, file validation and authorized downloads. Browser verification uses only the isolated PGlite server for writes, never production or the GHL reference account.
