// ============================================================================
// DOCUMENTS CORE  (server-side, pure)
//
// The database-free heart of the AI Business Setup + Proposals/Contracts slice,
// mirroring the repo's existing pattern (pure validators/authz in handlers.ts,
// commission-handlers.ts). Unit-tested with no database (documents-core.test.ts).
//
// It owns: section validation + the add/update/delete/reorder operations, the
// business-profile normalizer, role authorization, the AI prompt builder +
// response parser, and the snake_case row -> camelCase domain mappers used by
// the endpoints. The merge-field engine + section/status metadata live in the
// SHARED module src/lib/documents.ts (used by the client too).
// ============================================================================

import { ADMIN_ROLES, MANAGER_ROLES, SELF_ROLES, type Role } from "./auth.js";
import {
  coerceStyle,
  isSectionTypeValid,
  reorderByIds,
  sectionId,
  SECTION_LABELS,
} from "../../src/lib/documents.js";
import type {
  AiTarget,
  BusinessProfile,
  ClientDocument,
  DocumentKind,
  DocumentSection,
  DocumentTemplate,
  SectionType,
  SellsType,
} from "../../src/types/index.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const str = (v: unknown, fallback = ""): string => (v == null ? fallback : String(v).trim());

// ---------------------------------------------------------------------------
// Document kinds (extended). The shared DocumentKind stays proposal|contract for
// section-type/merge purposes; documents now additionally support quote,
// invoice and payment_request kinds. The `kind` column is free-text TEXT so no
// schema change is needed. Section validation for the new kinds reuses the
// proposal section set (they are proposal-shaped sales documents, not contracts).
// ---------------------------------------------------------------------------
export const DOCUMENT_KINDS = ["proposal", "contract", "quote", "invoice", "payment_request"] as const;
export type DocKind = (typeof DOCUMENT_KINDS)[number];
export function asDocumentKind(v: unknown): DocKind {
  const s = String(v ?? "").trim();
  return (DOCUMENT_KINDS as readonly string[]).includes(s) ? (s as DocKind) : "proposal";
}
/** The base kind used for section-type validation + merge defaults. */
export function sectionKind(kind: DocKind): DocumentKind {
  return kind === "contract" ? "contract" : "proposal";
}

// ---------------------------------------------------------------------------
// Document line items (pure). Shape only — catalog existence / assignment /
// price-floor validation (which needs the database) lives in _lib/products.ts.
// ---------------------------------------------------------------------------
export interface DocumentLineItem { productId: string; name: string; qty: number; unitPriceMinor: string; billingKind: string; description?: string; category?: string; recurringInterval?: string; currency?: string }
const LINE_BILLING_KINDS = ["one_time", "recurring", "setup"];
/** Coerce a stored/incoming line-item array into clean shapes (no DB checks). */
export function normalizeLineItems(raw: unknown): DocumentLineItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DocumentLineItem[] = [];
  for (const entry of raw.slice(0, 200)) {
    const o = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const productId = str(o.productId);
    if (!productId) continue;
    const qtyN = Number(o.qty);
    const qty = Number.isInteger(qtyN) && qtyN > 0 ? qtyN : 1;
    const unitPriceMinor = /^\d{1,28}$/.test(String(o.unitPriceMinor)) ? String(o.unitPriceMinor) : "0";
    const billingKind = LINE_BILLING_KINDS.includes(String(o.billingKind)) ? String(o.billingKind) : "one_time";
    out.push({ productId, name: str(o.name), qty, unitPriceMinor, billingKind, ...(o.description != null ? {description:str(o.description)} : {}), ...(o.category != null ? {category:str(o.category)} : {}), ...(o.recurringInterval != null ? {recurringInterval:str(o.recurringInterval)} : {}), ...(o.currency != null ? {currency:str(o.currency)} : {}) });
  }
  return out;
}
/** Sum qty * unitPriceMinor across line items → total in minor units (string). */
export function lineItemsAmountMinor(items: DocumentLineItem[]): string {
  return items.reduce((total, i) => total + BigInt(i.qty) * BigInt(i.unitPriceMinor), 0n).toString();
}

// ---------------------------------------------------------------------------
// Authorization (pure)
// ---------------------------------------------------------------------------

export type DocReadScope = "all" | "team" | "self";
export function docReadScope(role: Role): DocReadScope {
  if (ADMIN_ROLES.includes(role)) return "all";
  if (MANAGER_ROLES.includes(role)) return "team";
  return "self";
}
/** Templates + the business profile are managed by owner/admin (sub-account admin). */
export function canManageBusinessProfile(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}
/** Owner/admin/manager build & edit templates; self roles use them, not edit. */
export function canManageTemplates(role: Role): boolean {
  return ADMIN_ROLES.includes(role) || MANAGER_ROLES.includes(role);
}
/** Everyone with a portal seat can create a client document (self roles only for their own clients). */
export function canCreateClientDoc(role: Role): boolean {
  return ADMIN_ROLES.includes(role) || MANAGER_ROLES.includes(role) || SELF_ROLES.includes(role);
}
export function isSelfRole(role: Role): boolean {
  return SELF_ROLES.includes(role);
}

// ---------------------------------------------------------------------------
// Section validation + operations (pure)
// ---------------------------------------------------------------------------

const MAX_SECTIONS = 40;

/** Validate + clean a single incoming section for a given kind. */
export function normalizeSection(kind: DocumentKind, raw: unknown): DocumentSection {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const type: SectionType = isSectionTypeValid(kind, str(o.type)) ? (str(o.type) as SectionType) : "custom";
  const title = str(o.title) || SECTION_LABELS[type];
  const content = typeof o.content === "string" ? o.content : str(o.content);
  const id = str(o.id) || sectionId();
  return { id, type, title, content };
}

/** Validate + clean an incoming sections array (caps the count). */
export function normalizeSections(kind: DocumentKind, raw: unknown): DocumentSection[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_SECTIONS).map((s) => normalizeSection(kind, s));
}

export function addSection(
  sections: DocumentSection[],
  kind: DocumentKind,
  type: string,
  atIndex?: number,
): DocumentSection[] {
  const t: SectionType = isSectionTypeValid(kind, type) ? (type as SectionType) : "custom";
  const next = { id: sectionId(), type: t, title: SECTION_LABELS[t], content: "" };
  const out = [...sections];
  const i = atIndex == null || atIndex < 0 || atIndex > out.length ? out.length : atIndex;
  out.splice(i, 0, next);
  return out.slice(0, MAX_SECTIONS);
}

export function updateSection(
  sections: DocumentSection[],
  id: string,
  patch: { title?: string; content?: string; type?: string },
  kind: DocumentKind,
): DocumentSection[] {
  return sections.map((s) => {
    if (s.id !== id) return s;
    const next: DocumentSection = { ...s };
    if (patch.title != null) next.title = String(patch.title);
    if (patch.content != null) next.content = String(patch.content);
    if (patch.type != null && isSectionTypeValid(kind, String(patch.type))) {
      next.type = String(patch.type) as SectionType;
    }
    return next;
  });
}

export function deleteSection(sections: DocumentSection[], id: string): DocumentSection[] {
  return sections.filter((s) => s.id !== id);
}

export function reorderSections(sections: DocumentSection[], orderedIds: unknown): DocumentSection[] {
  if (!Array.isArray(orderedIds)) return sections;
  return reorderByIds(sections, orderedIds.map((x) => String(x)));
}

// ---------------------------------------------------------------------------
// Business profile validation (pure)
// ---------------------------------------------------------------------------

const SELLS: readonly SellsType[] = ["services", "software", "both"];

/**
 * Validate + normalize a business profile for upsert. This is a settings-style
 * record (no hard-required fields) so a profile can be saved progressively /
 * without AI. Everything is trimmed; enum-ish fields are coerced.
 */
export function normalizeBusinessProfile(body: Record<string, unknown>): Result<BusinessProfile> {
  const sells = (SELLS as readonly string[]).includes(str(body.sells)) ? (str(body.sells) as SellsType) : "services";
  return {
    ok: true,
    value: {
      businessName: str(body.businessName),
      logoUrl: str(body.logoUrl),
      website: str(body.website),
      industry: str(body.industry),
      description: str(body.description),
      services: str(body.services),
      software: str(body.software),
      sells,
      targetCustomers: str(body.targetCustomers),
      pricingModel: str(body.pricingModel),
      setupFees: str(body.setupFees),
      monthlyFees: str(body.monthlyFees),
      packages: str(body.packages),
      scopeOfWork: str(body.scopeOfWork),
      deliverables: str(body.deliverables),
      timeline: str(body.timeline),
      paymentTerms: str(body.paymentTerms),
      cancellationTerms: str(body.cancellationTerms),
      refundTerms: str(body.refundTerms),
      contractLength: str(body.contractLength),
      guarantees: str(body.guarantees),
      brandTone: str(body.brandTone) || "professional",
      companyAddress: str(body.companyAddress),
      contactEmail: str(body.contactEmail),
      contactPhone: str(body.contactPhone),
      legalLanguage: str(body.legalLanguage),
      proposalStyle: coerceStyle(body.proposalStyle),
      contractStyle: coerceStyle(body.contractStyle),
    },
  };
}

// ---------------------------------------------------------------------------
// Row <-> domain mappers
// ---------------------------------------------------------------------------

function parseSections(raw: unknown): DocumentSection[] {
  if (Array.isArray(raw)) return raw as DocumentSection[];
  if (typeof raw === "string" && raw.trim()) {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? (v as DocumentSection[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const iso = (v: any): string => (v ? new Date(v).toISOString() : "");
const isoOrNull = (v: any): string | null => (v ? new Date(v).toISOString() : null);

export function rowToTemplate(r: any): DocumentTemplate {
  return {
    id: r.id,
    kind: r.kind === "contract" ? "contract" : "proposal",
    name: r.name ?? "",
    description: r.description ?? "",
    style: coerceStyle(r.style),
    sections: parseSections(r.sections),
    isDefault: !!r.is_default,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

// ---------------------------------------------------------------------------
// FLOW 4 — prospect proposals + public approval (pure helpers)
// ---------------------------------------------------------------------------

/** A document addressed to someone who is not a client yet (stored as JSONB). */
export interface Prospect { name: string; email: string; company: string; phone: string; setupFee: number; monthlySubscription: number }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (v: unknown): boolean => typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v.trim());
const nonNeg = (v: unknown): number => { const n = Number(v ?? 0); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; };
/** Validate + clean an incoming prospect; name + valid email are required. */
export function normalizeProspect(raw: unknown): Result<Prospect> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = str(o.name).slice(0, 200), email = str(o.email).toLowerCase();
  if (!name) return { ok: false, error: "prospect_name_required" };
  if (!isEmail(email)) return { ok: false, error: "prospect_email_invalid" };
  return { ok: true, value: { name, email, company: str(o.company).slice(0, 200), phone: str(o.phone).slice(0, 50), setupFee: nonNeg(o.setupFee), monthlySubscription: nonNeg(o.monthlySubscription) } };
}
export function parseProspect(raw: unknown): Prospect | null {
  const v = raw && typeof raw === "object" ? raw : safeJson(raw);
  if (!v || typeof v !== "object") return null;
  const r = normalizeProspect(v);
  return r.ok ? r.value : null;
}
/** Shape a prospect like a client row so the merge engine + client insert can reuse it. */
export function prospectAsClient(p: Prospect) {
  return { companyName: p.company || p.name, contactName: p.name, email: p.email, phone: p.phone, setupFee: p.setupFee, monthlySubscription: p.monthlySubscription, signupDate: "" };
}
/** The cash the pending receipt should expect: the setup fee, or the whole amount when there is no split. */
export function receiptAmount(setupFee: number, total: number): number { return setupFee > 0 ? setupFee : total; }
/** Major units -> exact minor-unit string for the tracker ledger (never floats). */
export function toMinor(amount: number, minorDigits = 2): string { return BigInt(Math.round(Math.max(0, amount) * 10 ** minorDigits)).toString(); }
/** Pure rate-limit decision for the public endpoint. */
export const PROPOSAL_WINDOW_MIN = 15, PROPOSAL_MAX_REQUESTS = 120, PROPOSAL_MAX_FAILURES = 15;
export function proposalOverLimit(total: number, failures: number): boolean { return total >= PROPOSAL_MAX_REQUESTS || failures >= PROPOSAL_MAX_FAILURES; }
/** Validate the public acceptance form (name, email, typed signature, agreement). */
export function normalizeAcceptance(raw: unknown): Result<{ name: string; email: string; signature: string }> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = str(o.name).slice(0, 200), email = str(o.email).toLowerCase(), signature = str(o.signature).slice(0, 200);
  if (name.length < 2) return { ok: false, error: "name_required" };
  if (!isEmail(email)) return { ok: false, error: "email_invalid" };
  if (signature.length < 2) return { ok: false, error: "signature_required" };
  if (o.agree !== true) return { ok: false, error: "agreement_required" };
  return { ok: true, value: { name, email, signature } };
}

export interface ClientDocumentRow extends Omit<ClientDocument, "kind"> {
  kind: DocKind; lineItems: DocumentLineItem[]; campaignId: string | null;
  prospect: Prospect | null; sentTo: string | null; hasLink: boolean; linkExpiresAt: string | null;
  acceptedAt: string | null; acceptedByName: string | null; acceptedEmail: string | null;
  createdClientId: string | null; createdOpportunityId: string | null; receiptEventKey: string | null;
}

export function rowToDocument(r: any): ClientDocumentRow {
  return {
    id: r.id,
    kind: asDocumentKind(r.kind),
    lineItems: normalizeLineItems(
      Array.isArray(r.line_items) ? r.line_items : typeof r.line_items === "string" ? safeJson(r.line_items) : r.line_items,
    ),
    campaignId: r.campaign_id ?? null,
    ghlInvoiceId: r.ghl_invoice_id ?? null, ghlInvoiceStatus: r.ghl_invoice_status ?? null, ghlInvoiceUrl: r.ghl_invoice_url ?? null,
    title: r.title ?? "",
    clientId: r.client_id ?? null,
    salespersonId: r.salesperson_id ?? null,
    templateId: r.template_id ?? null,
    style: coerceStyle(r.style),
    sections: parseSections(r.sections),
    status: r.status ?? "draft",
    amount: Number(r.amount ?? 0),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    sentAt: isoOrNull(r.sent_at),
    viewedAt: isoOrNull(r.viewed_at),
    signedAt: isoOrNull(r.signed_at),
    canceledAt: isoOrNull(r.canceled_at),
    prospect: parseProspect(r.prospect), sentTo: r.sent_to ?? null, hasLink: !!r.public_token, linkExpiresAt: isoOrNull(r.token_expires_at),
    acceptedAt: isoOrNull(r.accepted_at), acceptedByName: r.accepted_by_name ?? null, acceptedEmail: r.accepted_email ?? null,
    createdClientId: r.created_client_id ?? null, createdOpportunityId: r.created_opportunity_id ?? null, receiptEventKey: r.receipt_event_key ?? null,
  };
}

export function rowToBusinessProfile(r: any): BusinessProfile {
  const p = (r.profile && typeof r.profile === "object" ? r.profile : safeJson(r.profile)) ?? {};
  return {
    businessName: r.business_name ?? "",
    logoUrl: r.logo_url ?? "",
    website: r.website ?? "",
    industry: r.industry ?? "",
    description: p.description ?? "",
    services: p.services ?? "",
    software: p.software ?? "",
    sells: (SELLS as readonly string[]).includes(p.sells) ? p.sells : "services",
    targetCustomers: p.targetCustomers ?? "",
    pricingModel: p.pricingModel ?? "",
    setupFees: p.setupFees ?? "",
    monthlyFees: p.monthlyFees ?? "",
    packages: p.packages ?? "",
    scopeOfWork: p.scopeOfWork ?? "",
    deliverables: p.deliverables ?? "",
    timeline: p.timeline ?? "",
    paymentTerms: p.paymentTerms ?? "",
    cancellationTerms: p.cancellationTerms ?? "",
    refundTerms: p.refundTerms ?? "",
    contractLength: p.contractLength ?? "",
    guarantees: p.guarantees ?? "",
    brandTone: r.brand_tone ?? "professional",
    companyAddress: r.address ?? "",
    contactEmail: r.contact_email ?? "",
    contactPhone: r.contact_phone ?? "",
    legalLanguage: p.legalLanguage ?? "",
    proposalStyle: coerceStyle(p.proposalStyle),
    contractStyle: coerceStyle(p.contractStyle),
    updatedAt: isoOrNull(r.updated_at) ?? undefined,
  };
}

/** Split a normalized profile into the first-class columns + the JSONB tail. */
export function businessProfileColumns(p: BusinessProfile): {
  columns: Record<string, string>;
  profile: Record<string, unknown>;
} {
  return {
    columns: {
      business_name: p.businessName,
      logo_url: p.logoUrl,
      website: p.website,
      industry: p.industry,
      address: p.companyAddress,
      contact_email: p.contactEmail,
      contact_phone: p.contactPhone,
      brand_tone: p.brandTone,
    },
    profile: {
      description: p.description,
      services: p.services,
      software: p.software,
      sells: p.sells,
      targetCustomers: p.targetCustomers,
      pricingModel: p.pricingModel,
      setupFees: p.setupFees,
      monthlyFees: p.monthlyFees,
      packages: p.packages,
      scopeOfWork: p.scopeOfWork,
      deliverables: p.deliverables,
      timeline: p.timeline,
      paymentTerms: p.paymentTerms,
      cancellationTerms: p.cancellationTerms,
      refundTerms: p.refundTerms,
      contractLength: p.contractLength,
      guarantees: p.guarantees,
      legalLanguage: p.legalLanguage,
      proposalStyle: p.proposalStyle,
      contractStyle: p.contractStyle,
    },
  };
}

function safeJson(v: unknown): any {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// AI: configuration, prompt building, response parsing (pure)
//
// The actual network call to OpenAI lives in api/ai.ts; everything here is pure
// so it can be tested without a key. aiConfigured() decides whether to even try.
// ---------------------------------------------------------------------------

export function aiConfigured(env: Record<string, string | undefined> = {}): boolean {
  const k = (env.OPENAI_API_KEY ?? env.OPENAI_KEY ?? "").trim();
  return k.length > 0;
}

export function aiModel(env: Record<string, string | undefined> = {}): string {
  return (env.OPENAI_MODEL ?? "gpt-4o-mini").trim() || "gpt-4o-mini";
}

function profileBrief(b: BusinessProfile | null): string {
  if (!b) return "No business profile has been provided.";
  const lines: string[] = [];
  const add = (label: string, v: string) => {
    if (v && v.trim()) lines.push(`- ${label}: ${v.trim()}`);
  };
  add("Business name", b.businessName);
  add("Industry", b.industry);
  add("What they sell", b.sells);
  add("Description", b.description);
  add("Services", b.services);
  add("Software/products", b.software);
  add("Target customers", b.targetCustomers);
  add("Pricing model", b.pricingModel);
  add("Setup fees", b.setupFees);
  add("Monthly fees", b.monthlyFees);
  add("Packages/plans", b.packages);
  add("Scope of work", b.scopeOfWork);
  add("Deliverables", b.deliverables);
  add("Timeline", b.timeline);
  add("Payment terms", b.paymentTerms);
  add("Cancellation terms", b.cancellationTerms);
  add("Refund terms", b.refundTerms);
  add("Contract length", b.contractLength);
  add("Guarantees/disclaimers", b.guarantees);
  add("Brand tone", b.brandTone);
  add("Legal language to include", b.legalLanguage);
  return lines.length ? lines.join("\n") : "No business profile details have been provided.";
}

function clientBrief(c: { companyName?: string; contactName?: string } | null): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.companyName) parts.push(`company ${c.companyName}`);
  if (c.contactName) parts.push(`contact ${c.contactName}`);
  return parts.length ? `This is for a specific client: ${parts.join(", ")}.` : "";
}

export interface GenerateInput {
  kind: DocumentKind;
  target: AiTarget;
  business: BusinessProfile | null;
  client?: { companyName?: string; contactName?: string } | null;
  /** Optional free-text instructions from the user. */
  instructions?: string;
  /** For target === 'section', the section type to generate. */
  sectionType?: SectionType;
}

/** Build the {system, user} chat messages for a generation request. */
export function buildGenerationMessages(input: GenerateInput): { system: string; user: string } {
  const allowed = input.kind === "contract"
    ? "parties, scope, payment_terms, term_length, cancellation, refund, confidentiality, responsibilities, disclaimers, signature, custom"
    : "cover, problem, solution, scope, deliverables, timeline, pricing, addons, terms, next_steps, signature, custom";

  const tone = input.business?.brandTone?.trim() || "professional";
  const kindWord = input.kind === "contract" ? "service contract" : "client proposal";

  let task: string;
  if (input.target === "email") {
    task =
      `Write a short, friendly follow-up email a salesperson can send after sending a ${kindWord}. ` +
      `Return JSON with a single section of type "custom": {"title":"Follow-up email","content":"<the email body>"}.`;
  } else if (input.target === "section" && input.sectionType) {
    task =
      `Write ONLY the "${input.sectionType}" section of a ${kindWord}. ` +
      `Return JSON with exactly one section object of that type.`;
  } else {
    task =
      `Generate a complete, well-structured ${kindWord} as an ordered list of sections. ` +
      `Use only these section types: ${allowed}. Include the most relevant 6-10 sections.`;
  }

  const system =
    `You are an expert proposal and contract writer for service and software businesses. ` +
    `Write in a ${tone} tone. You MUST respond with ONLY valid minified JSON and no markdown fences, ` +
    `matching exactly: {"title": string, "sections": [{"type": string, "title": string, "content": string}]}. ` +
    `"type" must be one of: ${allowed}. Keep "content" as readable plain text (short paragraphs; use line breaks, ` +
    `not markdown headings). Where a real value is unknown, use a merge token such as {{client_company}}, ` +
    `{{client_name}}, {{business_name}}, {{setup_fee}}, {{monthly_fee}}, {{start_date}} or {{payment_terms}} instead of inventing specifics. ` +
    (input.kind === "contract"
      ? `This is a template only; do not claim it is legal advice.`
      : `Make it persuasive but honest.`);

  const user =
    `${task}\n\n` +
    `${clientBrief(input.client ?? null)}\n\n` +
    `BUSINESS PROFILE:\n${profileBrief(input.business)}\n\n` +
    (input.instructions?.trim() ? `ADDITIONAL INSTRUCTIONS: ${input.instructions.trim()}\n\n` : "") +
    `Respond with JSON only.`;

  return { system, user };
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

/**
 * Parse a raw model response into a title + clean sections. Tolerant: strips
 * code fences, and if JSON parsing fails, wraps the raw text in a single custom
 * section so the user still gets usable output rather than an error.
 */
export function parseAiSections(
  raw: string,
  kind: DocumentKind,
): { title: string; sections: DocumentSection[] } {
  const cleaned = stripFences(String(raw ?? "")).trim();
  try {
    const obj = JSON.parse(cleaned);
    const title = typeof obj?.title === "string" ? obj.title : "";
    const sections = normalizeSections(kind, obj?.sections);
    if (sections.length) return { title, sections };
  } catch {
    /* fall through to plain-text fallback */
  }
  return {
    title: "",
    sections: [{ id: sectionId(), type: "custom", title: "Generated content", content: cleaned || String(raw ?? "") }],
  };
}
