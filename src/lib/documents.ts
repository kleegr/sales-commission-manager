// ============================================================================
// DOCUMENTS (shared, pure)
//
// Single source of truth for proposal/contract section metadata, the merge-field
// engine, status lifecycle, and starter sections. Imported by BOTH the React
// builder UI and the server (api/_lib/documents-core.ts + the endpoints), so it
// must stay free of any DOM/React/Node specifics — pure data + string helpers.
// ============================================================================

import type {
  BusinessProfile,
  Client,
  DocStatus,
  DocumentKind,
  DocumentSection,
  DocumentStyle,
  SectionType,
} from "../types";

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

export const PROPOSAL_SECTION_TYPES: SectionType[] = [
  "cover",
  "problem",
  "solution",
  "scope",
  "deliverables",
  "timeline",
  "pricing",
  "addons",
  "terms",
  "next_steps",
  "signature",
  "custom",
];

export const CONTRACT_SECTION_TYPES: SectionType[] = [
  "parties",
  "scope",
  "payment_terms",
  "term_length",
  "cancellation",
  "refund",
  "confidentiality",
  "responsibilities",
  "disclaimers",
  "signature",
  "custom",
];

export const SECTION_LABELS: Record<SectionType, string> = {
  cover: "Cover page",
  problem: "Client problem",
  solution: "Recommended solution",
  scope: "Scope of work",
  deliverables: "Deliverables",
  timeline: "Timeline",
  pricing: "Pricing",
  addons: "Optional add-ons",
  terms: "Terms",
  next_steps: "Next steps",
  signature: "Signature / approval",
  parties: "Parties",
  payment_terms: "Payment terms",
  term_length: "Term length",
  cancellation: "Cancellation",
  refund: "Refund terms",
  confidentiality: "Confidentiality",
  responsibilities: "Responsibilities",
  disclaimers: "Disclaimers",
  custom: "Custom section",
};

export function sectionTypesForKind(kind: DocumentKind): SectionType[] {
  return kind === "contract" ? CONTRACT_SECTION_TYPES : PROPOSAL_SECTION_TYPES;
}

export function isSectionTypeValid(kind: DocumentKind, type: string): boolean {
  return sectionTypesForKind(kind).includes(type as SectionType);
}

// ---------------------------------------------------------------------------
// Styles + status lifecycle
// ---------------------------------------------------------------------------

export const DOCUMENT_STYLES: DocumentStyle[] = ["modern", "classic", "minimal", "bold"];
export const STYLE_LABELS: Record<DocumentStyle, string> = {
  modern: "Modern",
  classic: "Classic",
  minimal: "Minimal",
  bold: "Bold",
};
export function coerceStyle(v: unknown): DocumentStyle {
  return DOCUMENT_STYLES.includes(v as DocumentStyle) ? (v as DocumentStyle) : "modern";
}

export const DOC_STATUSES: DocStatus[] = ["draft", "sent", "viewed", "signed", "canceled"];
export const STATUS_LABELS: Record<DocStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  signed: "Signed",
  canceled: "Canceled",
};
/** The next forward status in the happy path (cancel is always available). */
export const NEXT_STATUS: Partial<Record<DocStatus, DocStatus>> = {
  draft: "sent",
  sent: "viewed",
  viewed: "signed",
};
export function isValidStatus(s: string): s is DocStatus {
  return (DOC_STATUSES as string[]).includes(s);
}
/** A status is terminal once signed or canceled. */
export function isTerminalStatus(s: DocStatus): boolean {
  return s === "signed" || s === "canceled";
}
/**
 * Allowed status transitions. Forward along draft→sent→viewed→signed, cancel
 * from any non-terminal state, and re-opening a canceled draft back to draft.
 */
export function canTransitionStatus(from: DocStatus, to: DocStatus): boolean {
  if (from === to) return true;
  if (!isValidStatus(to)) return false;
  if (to === "canceled") return from !== "signed"; // can't cancel a signed doc
  if (from === "canceled") return to === "draft"; // reopen
  if (isTerminalStatus(from)) return false;
  const order: DocStatus[] = ["draft", "sent", "viewed", "signed"];
  return order.indexOf(to) >= order.indexOf(from);
}

// ---------------------------------------------------------------------------
// Merge fields
// ---------------------------------------------------------------------------

export type MergeFieldKey =
  | "business_name"
  | "business_logo"
  | "business_website"
  | "business_address"
  | "business_email"
  | "business_phone"
  | "client_name"
  | "client_company"
  | "client_email"
  | "client_phone"
  | "service_name"
  | "setup_fee"
  | "monthly_fee"
  | "start_date"
  | "salesperson_name"
  | "payment_terms"
  | "contract_terms";

export const MERGE_FIELDS: { key: MergeFieldKey; label: string }[] = [
  { key: "business_name", label: "Business name" },
  { key: "business_logo", label: "Business logo" },
  { key: "business_website", label: "Business website" },
  { key: "business_address", label: "Business address" },
  { key: "business_email", label: "Business email" },
  { key: "business_phone", label: "Business phone" },
  { key: "client_name", label: "Client name" },
  { key: "client_company", label: "Client company" },
  { key: "client_email", label: "Client email" },
  { key: "client_phone", label: "Client phone" },
  { key: "service_name", label: "Service name" },
  { key: "setup_fee", label: "Setup fee" },
  { key: "monthly_fee", label: "Monthly fee" },
  { key: "start_date", label: "Start date" },
  { key: "salesperson_name", label: "Salesperson name" },
  { key: "payment_terms", label: "Payment terms" },
  { key: "contract_terms", label: "Contract terms" },
];

const MERGE_LABEL: Record<string, string> = Object.fromEntries(
  MERGE_FIELDS.map((f) => [f.key, f.label]),
);
const MERGE_KEY_SET = new Set<string>(MERGE_FIELDS.map((f) => f.key));

/** Legacy tokens kept working for documents created before this slice. */
const TOKEN_ALIASES: Record<string, MergeFieldKey> = {
  company: "client_company",
  contact: "client_name",
  monthly: "monthly_fee",
};

export type MergeContext = Record<MergeFieldKey, string>;

function money(n: unknown): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v === 0) return "";
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * Build the merge context from the business profile + (optional) client +
 * salesperson. Missing values are left empty; applyMergeFields turns an empty
 * value into a clear `[Label]` placeholder instead of an empty string.
 */
export function buildMergeContext(input: {
  business?: BusinessProfile | null;
  client?: Pick<
    Client,
    "companyName" | "contactName" | "email" | "phone" | "setupFee" | "monthlySubscription" | "signupDate"
  > | null;
  salespersonName?: string | null;
  serviceName?: string | null;
  startDate?: string | null;
}): MergeContext {
  const b = input.business ?? null;
  const c = input.client ?? null;
  return {
    business_name: b?.businessName ?? "",
    business_logo: b?.logoUrl ?? "",
    business_website: b?.website ?? "",
    business_address: b?.companyAddress ?? "",
    business_email: b?.contactEmail ?? "",
    business_phone: b?.contactPhone ?? "",
    client_name: c?.contactName ?? "",
    client_company: c?.companyName ?? "",
    client_email: c?.email ?? "",
    client_phone: c?.phone ?? "",
    service_name: (input.serviceName ?? firstLine(b?.services)) || "",
    setup_fee: money(c?.setupFee),
    monthly_fee: money(c?.monthlySubscription),
    start_date: input.startDate ?? c?.signupDate ?? "",
    salesperson_name: input.salespersonName ?? "",
    payment_terms: b?.paymentTerms ?? "",
    contract_terms: b?.contractLength ?? "",
  };
}

function firstLine(s: string | undefined | null): string {
  if (!s) return "";
  const line = s.split(/[\n,]/)[0]?.trim() ?? "";
  return line;
}

/**
 * Replace `{{merge_field}}` tokens in `text`. A known token with a value is
 * substituted; a known token with no value becomes `[Label]`; an unknown token
 * is left untouched so it is obvious something is off rather than silently lost.
 */
export function applyMergeFields(text: string, ctx: Partial<MergeContext>): string {
  if (!text) return text;
  return text.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_full, rawKey: string) => {
    const lower = rawKey.toLowerCase();
    const key = (TOKEN_ALIASES[lower] ?? lower) as string;
    if (!MERGE_KEY_SET.has(key)) return `{{${rawKey}}}`;
    const value = (ctx as Record<string, string>)[key];
    if (value && value.trim()) return value;
    return `[${MERGE_LABEL[key]}]`;
  });
}

/** Apply merge fields to every section's title + content (returns new array). */
export function applySectionsMerge(
  sections: DocumentSection[],
  ctx: Partial<MergeContext>,
): DocumentSection[] {
  return sections.map((s) => ({
    ...s,
    title: applyMergeFields(s.title, ctx),
    content: applyMergeFields(s.content, ctx),
  }));
}

// ---------------------------------------------------------------------------
// Section + id helpers
// ---------------------------------------------------------------------------

let _seq = 0;
export function sectionId(): string {
  _seq = (_seq + 1) % 1_000_000;
  return `sec_${Date.now().toString(36)}_${_seq.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function emptySection(type: SectionType): DocumentSection {
  return { id: sectionId(), type, title: SECTION_LABELS[type], content: "" };
}

/** Reorder a section array to match `orderedIds`; unknown ids dropped, missing kept in place at end. */
export function reorderByIds(sections: DocumentSection[], orderedIds: string[]): DocumentSection[] {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const out: DocumentSection[] = [];
  for (const id of orderedIds) {
    const s = byId.get(id);
    if (s) {
      out.push(s);
      byId.delete(id);
    }
  }
  // append any sections that weren't named in orderedIds (defensive)
  for (const s of sections) if (byId.has(s.id)) out.push(s);
  return out;
}

// ---------------------------------------------------------------------------
// Starter sections (manual create) — include merge tokens so a manually built
// template still resolves to real data when used for a client.
// ---------------------------------------------------------------------------

function s(type: SectionType, title: string, content: string): DocumentSection {
  return { id: sectionId(), type, title, content };
}

export function defaultSections(kind: DocumentKind): DocumentSection[] {
  if (kind === "contract") {
    return [
      s("parties", "Parties", "This agreement is entered into between {{business_name}} (\"Provider\") and {{client_company}} (\"Client\"), represented by {{client_name}}."),
      s("scope", "Scope of Services", "The Provider will deliver the services described in the accepted proposal and summarized here."),
      s("payment_terms", "Payment Terms", "Client agrees to a setup fee of {{setup_fee}} and a recurring monthly fee of {{monthly_fee}}. {{payment_terms}}"),
      s("term_length", "Term", "This agreement begins on {{start_date}} and continues for {{contract_terms}}."),
      s("cancellation", "Cancellation", "Either party may cancel with written notice as described in this section."),
      s("refund", "Refunds", "Refund eligibility and process are described here."),
      s("responsibilities", "Responsibilities", "Each party's responsibilities are described here."),
      s("disclaimers", "Disclaimers", "Standard disclaimers and limitations of liability apply."),
      s("signature", "Signatures", "By signing below, both parties agree to the terms of this agreement.\n\nProvider: {{business_name}}\nClient: {{client_company}}"),
    ];
  }
  return [
    s("cover", "Proposal", "Prepared by {{business_name}} for {{client_company}}\nContact: {{client_name}}\nDate: {{start_date}}"),
    s("problem", "The Challenge", "A short summary of the problem {{client_company}} is facing."),
    s("solution", "Recommended Solution", "How {{business_name}} will solve it."),
    s("scope", "Scope of Work", "What is included in this engagement."),
    s("deliverables", "Deliverables", "The concrete deliverables {{client_company}} will receive."),
    s("timeline", "Timeline", "Key milestones and the expected timeline."),
    s("pricing", "Investment", "Setup fee: {{setup_fee}}\nMonthly: {{monthly_fee}}\n{{payment_terms}}"),
    s("next_steps", "Next Steps", "How to get started with {{business_name}}."),
    s("signature", "Approval", "Approved by {{client_name}} on behalf of {{client_company}}."),
  ];
}
