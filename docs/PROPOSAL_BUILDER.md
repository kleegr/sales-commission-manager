# Catalog-driven proposal builder

The Proposals page opens the client list by default. Create a proposal in four steps: Client & Salesman, Products & Pricing, Summary & Terms, and Review. Products, descriptions, categories and billing intervals come from Products. Saved items retain a snapshot so catalog edits do not change previously shared offers. Prices can meet or exceed the catalog floor; currency must match the workspace.

The server derives product identity and billing terms from the catalog. Client and seller access is tenant/team scoped. An existing client retains its salesman; new prospects can be assigned by an administrator. Proposal receipt and invoice integrations pin attribution to the proposal seller, even if CRM referral attribution later changes.

Shared and invoiced documents cannot be edited silently. A shared draft must be canceled and reopened, invalidating the old link. Approved and invoiced amounts remain locked. Share links track first view and signed approval. Approval creates a pending receipt, not earned cash. Existing GHL invoice callbacks post verified receipts and commission with idempotency protection. The list refreshes while visible every 15 seconds.

One-time and recurring totals are separate. First payment includes the first period of every recurring item. Recurring labels describe the agreed interval; this release does not provision recurring GHL subscriptions. The existing invoice path collects the initial payment. AI drafting uses the existing server-side OpenAI configuration, and email delivery uses the existing mail configuration. The client can print/save a PDF from the browser.

Verification: full repository regression suite, API/frontend TypeScript checks, production bundle, isolated Chrome create/save/share/view flow, desktop and 390px client layout. Automated tests cover approval, payment, duplicate delivery, saved attribution, tenant boundaries, product snapshots, draft locking and revoked links. No real client email or payment was sent during verification.

Not added in this release: configurable package allowances/block pricing, deposits/discounts, a separate declined status, optional signature mode, or automatic recurring subscription collection. These require additional pricing and lifecycle work and must not be inferred from the recurring line-item UI.
