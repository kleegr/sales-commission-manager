# Proposal workspace

The guided builder still handles the client, salesman, products, summary and review. Changes are saved as a private server-side working draft. Reopening an unfinished proposal restores the draft; concurrent tabs cannot silently overwrite a newer autosave. Saving creates or updates the proposal and opens its workspace.

## Products → Rules

Administrators can configure minimum/maximum quantities, a prerequisite product, included units per parent product, quantity-based unit prices, private delivery costs, and onboarding task templates. Proposal totals, public breakdowns, invoice quantities and commission amounts use the same charged quantity. A quantity of five with one included unit bills four. Volume prices apply to every charged unit at the highest qualifying threshold. Duplicate rows must be combined into one quantity.

Costs never appear in seller, manager or public responses. Margin estimates subtract delivery costs and commissions for all beneficiaries. The salesman estimate uses the existing commission calculation engine and effective campaign/product/default plan assignments, assuming payment today with no taxes or fees. Missing or ambiguous assignments are shown as unconfigured, never as guaranteed earnings.

## Proposal → Workspace

- **Overview:** first payment, commission and private margin estimates, follow-up date, activity, basic quality checks, and an optional AI review.
- **Offer options:** up to three product packages, effective/delivery/renewal dates, an editable value estimate, an exception note, and private handover notes. Save options before sharing.
- **Internal approval:** administrators can require every proposal, amounts over a threshold, or custom payment terms to receive review. Exception notes always require review. A separate manager or administrator must approve the exact offer. Changing commercial terms invalidates the approval.
- **Client questions:** messages, change requests and HTTPS links to supporting documents remain with the proposal. Team replies become visible on the client page. Client names are self-reported by holders of the private link.
- **Onboarding:** verified payment creates one kickoff task plus tasks from the shared product configuration. Tasks are idempotent and track to-do, in-progress and completed status. Approval alone does not create paid onboarding.
- **Versions & renewals:** create separate revision, renewal or expansion drafts. Compare their quantities, prices and text with the original. Original approvals and links remain intact.

New links preserve older unexpired links. Tokens remain stored as hashes. Canceling a proposal revokes its links; revisions get independent links. Branding and merged text are frozen on first sharing, and the selected package is saved with the client's approval.

## Client page

Clients can compare packages, see quantities/prices update, explore value assumptions, ask questions or request changes, and approve the selected package. Existing invoice/payment integration remains in use. The value calculator is explicitly an estimate and does not alter the agreed price.

## Activation and boundaries

- AI drafting and quality review use the existing server-side `OPENAI_API_KEY` configuration and AI feature permissions. Deterministic checks work without AI. Provider availability and quota must be verified in Production separately.
- Follow-up dates are internal reminders. No automatic client emails are enabled by this release.
- Supporting documents use HTTPS links; binary file uploading is not included.
- Renewal and expansion actions prepare offers. They do not modify a payment-provider subscription or charge a client automatically. Recurring price labels do not create recurring billing schedules.
- Payouts and payment collection retain the existing reviewed workflows. No automatic money transfer is introduced.
- New tables are additive and tenant-scoped through migration `0022_proposal_workspace`. Existing proposals, signatures, financial records and product prices are preserved.

## Verification

`api/_lib/proposal-suite.test.ts` covers rule enforcement, pricing, private autosave isolation/conflicts, role-sensitive finance, packages, approval gates, stable links, frozen branding, messages, selected-package acceptance, idempotent paid onboarding and renewal isolation. Existing proposal, product catalog and invoice integration suites cover backward compatibility. Tests use embedded Postgres and do not contact live payment or AI providers.
