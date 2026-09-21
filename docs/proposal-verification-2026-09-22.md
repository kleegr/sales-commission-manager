# Proposal verification — 22 September 2026

## Result

The proposal workflow was tested with isolated data, real application handlers and an embedded PostgreSQL-compatible database. Bugs found during this review were fixed and covered with regression tests. No production customer was messaged, charged, signed for or added by these tests.

Validation: all 37 test files in the configured application suite passed. The separate business-name test file also passed (5 checks). The new proposal regression suite contains 22 passing scenarios. Frontend and API type checks and the production build passed. A local browser walkthrough reported no browser console errors.

## Verified functionality

| Area | What was exercised |
| --- | --- |
| Creation and editing | New client/prospect, assigned salesman, saved draft, repeat editing, conflict protection and recovery of autosaved work. |
| Products and pricing | One-time and recurring products, changing quantities, exact totals, product-specific commission rates, volume prices, included units, dependencies and limits. |
| Packages | Multiple offers with different quantities/prices, required client choice and preservation of the selected offer. |
| Business presentation | Saved business details, replacement of business-name placeholders and a readable public proposal. |
| Value calculator | Hours saved, hourly value and adoption assumptions; immediate client-side recalculation. |
| Internal review | Approval rules, a different reviewer, rejected self-approval, changed-offer invalidation and retained approval after package selection. |
| Sharing and client approval | Link creation, public view, client question, chosen package, typed test signature and approval record. Cancellation revokes old links. |
| Billing and commission | Invoice reuse, wrong-location event rejection, manual collection preview, product-specific commission, one charge per checkout, duplicate/replayed payment protection and preservation of historical confirmed receipts. |
| Delivery | Onboarding starts after verified payment, tasks update and repeat payment events do not duplicate tasks. |
| Versions | Revision, renewal and expansion create separate drafts and preserve the original signature. These actions do not change subscriptions or charge clients. |
| AI | Simulated successful generation, business-name resolution, role-scoped history, empty provider output, unavailable provider and missing configuration. |
| Access | Tenant boundaries, salesman scope, unlinked users, manager team scope and hidden private cost information. |

## Browser example

Created “QA — Website and messaging project” for an isolated test company and assigned Jordan Test. Selected a $249 setup service plus three $19/month messaging accounts. The page immediately showed $306 first payment and $57/month.

Added Essential ($268) and Recommended ($306) packages. The value calculator showed $480/month for 12 hours × $50 × 80%. Opened the public link, chose Recommended, added a question and submitted the non-binding local test approval. The app created a pending $306 receipt. Collection preview showed $30.60 commission; confirming the simulated collection created the product receipts and onboarding task. Completed the task, created a revision, and verified that the original remained approved.

## Bugs fixed

1. Unsaved package edits could disappear after another workspace action. The UI now requires saving those edits first and makes the save action available across tabs.
2. PostgreSQL microsecond timestamps could falsely block a legitimate draft save. Comparisons now use the precision sent to the browser while retaining stale-edit protection.
3. Clearing an outdated autosave could silently fail and disable further saves. It now reports a conflict and preserves the newer draft.
4. Sharing could overlook changed product prices or included quantities inside alternate packages. Every offered package is revalidated before first sharing.
5. Internal approval could appear lost after a client selected a reviewed package. The shared approval snapshot now identifies the reviewed offer.
6. Repeated invoice creation could issue another invoice. Existing invoices are reused.
7. Manual confirmation could use a general commission rate instead of the proposal’s product rules, and a later invoice event could duplicate credit. Both collection paths now share the same product receipt identities.
8. Products within one checkout advanced the payment count separately, skipping first-purchase commission on later products. The commission preview and posting engine now count the proposal checkout once.
9. A later-day replay of a paid event could conflict with the original date. Matching confirmed product receipts are reused without reposting.
10. A paid event from a different provided location could alter a proposal. It is rejected before financial changes.
11. A manually collected proposal could still display “receipt pending.” Confirmed receipts now drive that display and the payment-confirmed count.
12. Unlinked salesman accounts could read unassigned workspaces, and manager AI requests could use clients outside their team. Both scope checks are enforced.
13. Empty AI output could be reported as success. It now produces a useful retry error. Quality checks also recognize differently capitalized business-name placeholders.
14. A catalog offer containing only zero-value products could attempt to create a zero-value invoice. It is rejected without contacting the invoice provider.

## Boundaries

- Invoice, email and AI provider behavior was simulated. This verifies application handling, not live provider delivery, account permissions or billing configuration.
- No real payment, fund transfer or customer communication was performed.
- Live OpenAI generation remains unverified. Earlier automatic approval review blocked inspecting the production environment settings because that could expose credentials; those settings were not accessed during this test.
- Existing historical commission entries were not recalculated or rewritten. These fixes protect new posting and retries; past financial corrections require a separate, reviewed reconciliation.
- Browser testing covered the desktop proposal workflow. It does not establish compatibility with every browser, device or third-party outage.

## Reproduce locally

Run the package test suite, plus `node node_modules/tsx/dist/cli.mjs src/lib/proposal-business-name.test.ts`. The focused new suite is `api/_lib/proposal-regressions.test.ts`. For browser verification, build the app and run `scripts/dev-tracker.ts`; it seeds an isolated local workspace, blocks external requests and supplies a fake invoice provider.
