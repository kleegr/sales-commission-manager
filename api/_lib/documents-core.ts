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

export function rowToDocument(r: any): ClientDocument {
  return {
    id: r.id,
    kind: r.kind === "contract" ? "contract" : "proposal",
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
