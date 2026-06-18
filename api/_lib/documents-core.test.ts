// Dependency-free, DB-free tests for the AI Business Setup + Proposals /
// Contracts core: merge fields, section ops, status lifecycle, business-profile
// normalization, AI prompt building / parsing, and role authorization.
// Run via `tsx api/_lib/documents-core.test.ts` (wired into `npm test`).
import {
  docReadScope,
  canManageBusinessProfile,
  canManageTemplates,
  canCreateClientDoc,
  isSelfRole,
  normalizeSection,
  normalizeSections,
  addSection,
  updateSection,
  deleteSection,
  reorderSections,
  normalizeBusinessProfile,
  businessProfileColumns,
  rowToBusinessProfile,
  rowToTemplate,
  rowToDocument,
  aiConfigured,
  aiModel,
  buildGenerationMessages,
  parseAiSections,
} from "./documents-core.js";
import {
  applyMergeFields,
  applySectionsMerge,
  buildMergeContext,
  canTransitionStatus,
  isValidStatus,
  isTerminalStatus,
  NEXT_STATUS,
  isSectionTypeValid,
  sectionTypesForKind,
  reorderByIds,
  defaultSections,
  coerceStyle,
  MERGE_FIELDS,
} from "../../src/lib/documents.js";
import type { BusinessProfile, DocumentSection } from "../../src/types/index.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}`);
  }
}

// A reasonably complete profile to exercise the merge engine + AI brief.
const profile: BusinessProfile = {
  businessName: "Acme Studio",
  logoUrl: "https://cdn.example.com/logo.png",
  website: "https://acme.example.com",
  industry: "Marketing",
  description: "We grow brands.",
  services: "SEO\nPaid ads",
  software: "",
  sells: "services",
  targetCustomers: "SMBs",
  pricingModel: "Retainer",
  setupFees: "$1,000",
  monthlyFees: "$2,500",
  packages: "Starter, Growth",
  scopeOfWork: "Audit, strategy, execution",
  deliverables: "Monthly report",
  timeline: "90 days",
  paymentTerms: "Net 15",
  cancellationTerms: "30 days notice",
  refundTerms: "No refunds after work begins",
  contractLength: "12 months",
  guarantees: "Satisfaction guarantee",
  brandTone: "confident",
  companyAddress: "123 Main St",
  contactEmail: "hi@acme.example.com",
  contactPhone: "555-0100",
  legalLanguage: "Governed by the laws of Delaware.",
  proposalStyle: "modern",
  contractStyle: "classic",
};

const client = {
  companyName: "Globex LLC",
  contactName: "Jane Doe",
  email: "jane@globex.example.com",
  phone: "555-0200",
  setupFee: 1500,
  monthlySubscription: 3000,
  signupDate: "2026-02-01",
};

// ---------------------------------------------------------------------------
console.log("\n[Documents \u00b7 authorization]");
ok("owner reads all", docReadScope("owner" as any) === "all");
ok("admin reads all", docReadScope("admin" as any) === "all");
ok("sales_manager reads team", docReadScope("sales_manager" as any) === "team");
ok("salesperson reads self", docReadScope("salesperson" as any) === "self");
ok("affiliate reads self", docReadScope("affiliate" as any) === "self");

ok("owner manages business profile", canManageBusinessProfile("owner" as any));
ok("admin manages business profile", canManageBusinessProfile("admin" as any));
ok("manager CANNOT manage business profile", !canManageBusinessProfile("sales_manager" as any));
ok("salesperson CANNOT manage business profile", !canManageBusinessProfile("salesperson" as any));

ok("owner manages templates", canManageTemplates("owner" as any));
ok("manager manages templates", canManageTemplates("sales_manager" as any));
ok("salesperson CANNOT manage templates", !canManageTemplates("salesperson" as any));
ok("affiliate CANNOT manage templates", !canManageTemplates("affiliate" as any));

ok("owner can create client doc", canCreateClientDoc("owner" as any));
ok("manager can create client doc", canCreateClientDoc("sales_manager" as any));
ok("salesperson can create client doc", canCreateClientDoc("salesperson" as any));
ok("affiliate can create client doc", canCreateClientDoc("affiliate" as any));

ok("salesperson is self role", isSelfRole("salesperson" as any));
ok("owner is not self role", !isSelfRole("owner" as any));

// ---------------------------------------------------------------------------
console.log("\n[Documents \u00b7 section types]");
ok("proposal allows cover", isSectionTypeValid("proposal", "cover"));
ok("proposal rejects parties", !isSectionTypeValid("proposal", "parties"));
ok("contract allows parties", isSectionTypeValid("contract", "parties"));
ok("contract rejects cover", !isSectionTypeValid("contract", "cover"));
ok("custom valid for both", isSectionTypeValid("proposal", "custom") && isSectionTypeValid("contract", "custom"));
ok("unknown type invalid", !isSectionTypeValid("proposal", "banana"));
ok("proposal type list non-empty", sectionTypesForKind("proposal").length > 5);
ok("contract type list non-empty", sectionTypesForKind("contract").length > 5);

// ---------------------------------------------------------------------------
console.log("\n[Documents \u00b7 section normalize + ops]");
const ns = normalizeSection("proposal", { type: "pricing", title: "  Cost  ", content: "x", id: "a1" });
ok("normalizeSection keeps valid type", ns.type === "pricing");
ok("normalizeSection trims title", ns.title === "Cost");
ok("normalizeSection keeps id", ns.id === "a1");
const nsBad = normalizeSection("proposal", { type: "parties", title: "" });
ok("normalizeSection coerces wrong-kind type to custom", nsBad.type === "custom");
ok("normalizeSection falls back to label title", nsBad.title === "Custom section");
ok("normalizeSection mints id when missing", !!nsBad.id && nsBad.id.length > 3);

ok("normalizeSections returns [] for non-array", normalizeSections("proposal", "nope").length === 0);
const many = normalizeSections(
  "proposal",
  Array.from({ length: 60 }, (_, i) => ({ type: "custom", title: `s${i}`, content: "" })),
);
ok("normalizeSections caps at 40", many.length === 40);

let secs: DocumentSection[] = defaultSections("proposal");
const startLen = secs.length;
secs = addSection(secs, "proposal", "addons");
ok("addSection appends", secs.length === startLen + 1 && secs[secs.length - 1].type === "addons");
secs = addSection(secs, "proposal", "parties"); // wrong kind -> custom
ok("addSection coerces wrong-kind to custom", secs[secs.length - 1].type === "custom");
const midId = secs[2].id;
secs = updateSection(secs, midId, { title: "Renamed", content: "Body" }, "proposal");
const updated = secs.find((s) => s.id === midId)!;
ok("updateSection sets title", updated.title === "Renamed");
ok("updateSection sets content", updated.content === "Body");
const beforeDel = secs.length;
secs = deleteSection(secs, midId);
ok("deleteSection removes one", secs.length === beforeDel - 1 && !secs.some((s) => s.id === midId));

const r3 = [
  { id: "x", type: "custom", title: "X", content: "" },
  { id: "y", type: "custom", title: "Y", content: "" },
  { id: "z", type: "custom", title: "Z", content: "" },
] as DocumentSection[];
const reordered = reorderSections(r3, ["z", "x", "y"]);
ok("reorderSections honors order", reordered.map((s) => s.id).join(",") === "z,x,y");
const partial = reorderByIds(r3, ["y"]);
ok("reorderByIds keeps unnamed at end", partial.map((s) => s.id).join(",") === "y,x,z");
const dropped = reorderByIds(r3, ["q", "z"]);
ok("reorderByIds drops unknown ids", dropped.map((s) => s.id).join(",") === "z,x,y");

// ---------------------------------------------------------------------------
console.log("\n[Documents \u00b7 status lifecycle]");
ok("draft is valid", isValidStatus("draft"));
ok("garbage is invalid", !isValidStatus("nope"));
ok("signed is terminal", isTerminalStatus("signed"));
ok("canceled is terminal", isTerminalStatus("canceled"));
ok("draft not terminal", !isTerminalStatus("draft"));
ok("draft -> sent allowed", canTransitionStatus("draft", "sent"));
ok("sent -> viewed allowed", canTransitionStatus("sent", "viewed"));
ok("viewed -> signed allowed", canTransitionStatus("viewed", "signed"));
ok("draft -> signed allowed (forward skip)", canTransitionStatus("draft", "signed"));
ok("signed -> sent rejected (no backward)", !canTransitionStatus("signed", "sent"));
ok("signed -> canceled rejected", !canTransitionStatus("signed", "canceled"));
ok("draft -> canceled allowed", canTransitionStatus("draft", "canceled"));
ok("canceled -> draft allowed (reopen)", canTransitionStatus("canceled", "draft"));
ok("canceled -> sent rejected", !canTransitionStatus("canceled", "sent"));
ok("same status allowed (idempotent)", canTransitionStatus("sent", "sent"));
ok("NEXT_STATUS draft is sent", NEXT_STATUS.draft === "sent");
ok("NEXT_STATUS signed undefined", NEXT_STATUS.signed === undefined);

// ---------------------------------------------------------------------------
console.log("\n[Documents \u00b7 merge fields]");
const ctx = buildMergeContext({ business: profile, client, salespersonName: "Sam Sales", startDate: null });
ok("ctx business_name", ctx.business_name === "Acme Studio");
ok("ctx client_company", ctx.client_company === "Globex LLC");
ok("ctx client_name", ctx.client_name === "Jane Doe");
ok("ctx setup_fee formatted", ctx.setup_fee === "$1,500");
ok("ctx monthly_fee formatted", ctx.monthly_fee === "$3,000");
ok("ctx start_date from client signupDate", ctx.start_date === "2026-02-01");
ok("ctx salesperson_name", ctx.salesperson_name === "Sam Sales");
ok("ctx service_name from first service line", ctx.service_name === "SEO");

ok(
  "applyMergeFields substitutes known token",
  applyMergeFields("Hi {{client_name}}", ctx) === "Hi Jane Doe",
);
ok(
  "applyMergeFields placeholder for empty value",
  applyMergeFields("Ref: {{contract_terms}}", { contract_terms: "" }) === "Ref: [Contract terms]",
);
ok(
  "applyMergeFields leaves unknown token intact",
  applyMergeFields("X {{not_a_field}} Y", ctx) === "X {{not_a_field}} Y",
);
ok(
  "applyMergeFields legacy alias company",
  applyMergeFields("{{company}}", ctx) === "Globex LLC",
);
ok(
  "applyMergeFields tolerates whitespace in token",
  applyMergeFields("{{  business_name  }}", ctx) === "Acme Studio",
);
ok("applyMergeFields empty string safe", applyMergeFields("", ctx) === "");
const merged = applySectionsMerge(
  [{ id: "s1", type: "cover", title: "{{business_name}}", content: "For {{client_company}}" }],
  ctx,
);
ok("applySectionsMerge title", merged[0].title === "Acme Studio");
ok("applySectionsMerge content", merged[0].content === "For Globex LLC");
ok("merge field catalog has 17 entries", MERGE_FIELDS.length === 17);
const missingClientCtx = buildMergeContext({ business: profile, client: null });
ok(
  "missing client -> placeholder not crash",
  applyMergeFields("{{client_company}}", missingClientCtx) === "[Client company]",
);

// ---------------------------------------------------------------------------
console.log("\n[Documents \u00b7 business profile normalize]");
const np = normalizeBusinessProfile({
  businessName: "  Beta Co  ",
  sells: "both",
  proposalStyle: "bold",
  contractStyle: "nonsense",
  setupFees: 500,
});
ok("normalize ok", np.ok);
ok("normalize trims businessName", np.ok && np.value.businessName === "Beta Co");
ok("normalize keeps valid sells", np.ok && np.value.sells === "both");
ok("normalize coerces bad sells default", (() => { const r = normalizeBusinessProfile({ sells: "junk" }); return r.ok && r.value.sells === "services"; })());
ok("normalize keeps valid style", np.ok && np.value.proposalStyle === "bold");
ok("normalize coerces bad style to modern", np.ok && np.value.contractStyle === "modern");
ok("normalize stringifies numeric fee", np.ok && np.value.setupFees === "500");
ok("normalize default brand tone", np.ok && np.value.brandTone === "professional");

const split = businessProfileColumns(profile);
ok("columns include business_name", split.columns.business_name === "Acme Studio");
ok("columns include logo_url", split.columns.logo_url === profile.logoUrl);
ok("columns include brand_tone", split.columns.brand_tone === "confident");
ok("jsonb tail has description", split.profile.description === "We grow brands.");
ok("jsonb tail has sells", split.profile.sells === "services");
ok("jsonb tail has proposalStyle", split.profile.proposalStyle === "modern");
ok("business_name NOT duplicated in jsonb tail", !("businessName" in split.profile));

const rtBp = rowToBusinessProfile({
  business_name: "Beta Co",
  logo_url: "L",
  website: "W",
  industry: "Tech",
  address: "Addr",
  contact_email: "e@x.com",
  contact_phone: "p",
  brand_tone: "warm",
  profile: { description: "d", services: "s", sells: "software", proposalStyle: "minimal" },
  updated_at: "2026-03-01T00:00:00Z",
});
ok("rowToBusinessProfile maps columns", rtBp.businessName === "Beta Co" && rtBp.companyAddress === "Addr");
ok("rowToBusinessProfile maps jsonb", rtBp.description === "d" && rtBp.sells === "software");
ok("rowToBusinessProfile coerces style", rtBp.proposalStyle === "minimal");
const rtBpStr = rowToBusinessProfile({ business_name: "C", profile: '{"description":"json-string"}' });
ok("rowToBusinessProfile parses stringified jsonb", rtBpStr.description === "json-string");

// ---------------------------------------------------------------------------
console.log("\n[Documents \u00b7 row mappers]");
const tpl = rowToTemplate({
  id: "t1",
  kind: "contract",
  name: "Std",
  description: "d",
  style: "classic",
  sections: JSON.stringify([{ id: "s", type: "parties", title: "P", content: "c" }]),
  is_default: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
});
ok("rowToTemplate kind", tpl.kind === "contract");
ok("rowToTemplate parses stringified sections", tpl.sections.length === 1 && tpl.sections[0].type === "parties");
ok("rowToTemplate isDefault bool", tpl.isDefault === true);
ok("rowToTemplate iso dates", tpl.createdAt.startsWith("2026-01-01"));
const tplArr = rowToTemplate({ id: "t2", kind: "weird", sections: [{ id: "s", type: "cover", title: "", content: "" }] });
ok("rowToTemplate unknown kind -> proposal", tplArr.kind === "proposal");
ok("rowToTemplate accepts array sections", tplArr.sections.length === 1);

const doc = rowToDocument({
  id: "d1",
  kind: "proposal",
  title: "Prop",
  client_id: "c1",
  salesperson_id: "sp1",
  template_id: "t1",
  style: "modern",
  sections: [{ id: "s", type: "cover", title: "T", content: "B" }],
  status: "sent",
  amount: "1234.5",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  sent_at: "2026-01-03T00:00:00Z",
  viewed_at: null,
  signed_at: null,
  canceled_at: null,
});
ok("rowToDocument status", doc.status === "sent");
ok("rowToDocument amount numeric", doc.amount === 1234.5);
ok("rowToDocument clientId", doc.clientId === "c1");
ok("rowToDocument sentAt iso", (doc.sentAt ?? "").startsWith("2026-01-03"));
ok("rowToDocument null viewedAt", doc.viewedAt === null);

// ---------------------------------------------------------------------------
console.log("\n[Documents \u00b7 AI config + prompt + parse]");
ok("aiConfigured false when empty", !aiConfigured({}));
ok("aiConfigured true with OPENAI_API_KEY", aiConfigured({ OPENAI_API_KEY: "sk-x" }));
ok("aiConfigured true with OPENAI_KEY alias", aiConfigured({ OPENAI_KEY: "sk-y" }));
ok("aiConfigured false when whitespace", !aiConfigured({ OPENAI_API_KEY: "   " }));
ok("aiModel default", aiModel({}) === "gpt-4o-mini");
ok("aiModel override", aiModel({ OPENAI_MODEL: "gpt-4o" }) === "gpt-4o");

const gen = buildGenerationMessages({ kind: "proposal", target: "template", business: profile, instructions: "Be punchy" });
ok("gen system mentions JSON", /JSON/i.test(gen.system));
ok("gen system carries brand tone", /confident/.test(gen.system));
ok("gen user includes profile brief", /Acme Studio/.test(gen.user));
ok("gen user includes instructions", /Be punchy/.test(gen.user));
ok("gen proposal allows cover type", /cover/.test(gen.system));
const genC = buildGenerationMessages({ kind: "contract", target: "template", business: profile });
ok("gen contract allows parties type", /parties/.test(genC.system));
ok("gen contract not legal advice note", /legal advice/i.test(genC.system));
const genSec = buildGenerationMessages({ kind: "proposal", target: "section", business: profile, sectionType: "pricing" });
ok("gen section targets one section", /pricing/.test(genSec.user) && /one section/i.test(genSec.user));
const genEmail = buildGenerationMessages({ kind: "proposal", target: "email", business: profile, client });
ok("gen email mentions follow-up", /follow-up email/i.test(genEmail.user));
ok("gen email includes client brief", /Globex LLC/.test(genEmail.user));
const genNoProfile = buildGenerationMessages({ kind: "proposal", target: "template", business: null });
ok("gen handles null profile", /No business profile/i.test(genNoProfile.user));

const parsedGood = parseAiSections(
  '```json\n{"title":"My Proposal","sections":[{"type":"cover","title":"Cover","content":"Hi"},{"type":"pricing","title":"Cost","content":"$x"}]}\n```',
  "proposal",
);
ok("parseAiSections strips fences + parses", parsedGood.sections.length === 2);
ok("parseAiSections keeps title", parsedGood.title === "My Proposal");
ok("parseAiSections keeps valid types", parsedGood.sections[0].type === "cover");
const parsedCoerce = parseAiSections('{"sections":[{"type":"parties","title":"P","content":"c"}]}', "proposal");
ok("parseAiSections coerces wrong-kind type to custom", parsedCoerce.sections[0].type === "custom");
const parsedJunk = parseAiSections("totally not json at all", "proposal");
ok("parseAiSections falls back to single custom section", parsedJunk.sections.length === 1 && parsedJunk.sections[0].type === "custom");
ok("parseAiSections fallback keeps raw text", parsedJunk.sections[0].content === "totally not json at all");
const parsedEmpty = parseAiSections('{"title":"x","sections":[]}', "proposal");
ok("parseAiSections empty sections -> fallback", parsedEmpty.sections.length === 1);

// ---------------------------------------------------------------------------
console.log("\n[Documents \u00b7 defaults + style]");
ok("default proposal sections present", defaultSections("proposal").length >= 7);
ok("default contract sections present", defaultSections("contract").length >= 7);
ok("default proposal starts with cover", defaultSections("proposal")[0].type === "cover");
ok("default contract starts with parties", defaultSections("contract")[0].type === "parties");
ok("default proposal carries merge token", defaultSections("proposal").some((s) => s.content.includes("{{")));
ok("coerceStyle valid passes", coerceStyle("bold") === "bold");
ok("coerceStyle invalid -> modern", coerceStyle("zzz") === "modern");

console.log(`\n========================\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
