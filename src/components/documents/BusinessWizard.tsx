// ============================================================================
// BusinessWizard — the guided AI Business Setup. Six visual steps collect a
// tenant's business profile (saved via /api/business-profile). It is the source
// of the merge-field values + the grounding context for AI generation. There are
// no hard-required fields, so a profile can be saved progressively and the rest
// of the system works with or without AI.
// ============================================================================

import { useState } from "react";
import { Loader2, Check, ArrowLeft, ArrowRight } from "lucide-react";
import { Card, Button, SectionTitle } from "../ui";
import { Field, Input, Textarea, Select } from "../ui/form";
import { DOCUMENT_STYLES, STYLE_LABELS } from "../../lib/documents";
import { saveBusinessProfile } from "../../lib/resource-client";
import type { BusinessProfile, SellsType, DocumentStyle } from "../../types";

const EMPTY: BusinessProfile = {
  businessName: "",
  logoUrl: "",
  website: "",
  industry: "",
  description: "",
  services: "",
  software: "",
  sells: "services",
  targetCustomers: "",
  pricingModel: "",
  setupFees: "",
  monthlyFees: "",
  packages: "",
  scopeOfWork: "",
  deliverables: "",
  timeline: "",
  paymentTerms: "",
  cancellationTerms: "",
  refundTerms: "",
  contractLength: "",
  guarantees: "",
  brandTone: "professional",
  companyAddress: "",
  contactEmail: "",
  contactPhone: "",
  legalLanguage: "",
  proposalStyle: "modern",
  contractStyle: "classic",
};

const STEPS = ["Business basics", "Services & offers", "Pricing & packages", "Terms & policies", "Branding & tone", "Review & save"];

export function BusinessWizard({
  initial,
  onSaved,
  onCancel,
}: {
  initial: BusinessProfile | null;
  onSaved: (p: BusinessProfile) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<BusinessProfile>({ ...EMPTY, ...(initial ?? {}) });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof BusinessProfile>(key: K, value: BusinessProfile[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const prev = () => setStep((s) => Math.max(s - 1, 0));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveBusinessProfile(form);
      onSaved(saved);
    } catch (e: any) {
      setError(e?.message === "forbidden" ? "Only an owner or admin can edit the business profile." : "Could not save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-0">
      {/* Stepper */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-5 py-4 dark:border-slate-700">
        {STEPS.map((label, i) => (
          <button
            key={label}
            onClick={() => setStep(i)}
            className={[
              "flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium transition",
              i === step
                ? "bg-brand-600 text-white"
                : i < step
                  ? "bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300"
                  : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
            ].join(" ")}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-[10px]">
              {i < step ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      <div className="space-y-4 px-5 py-5">
        {step === 0 && (
          <>
            <SectionTitle>Business basics</SectionTitle>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Business name"><Input value={form.businessName} onChange={(e) => set("businessName", e.target.value)} placeholder="Acme Studio" /></Field>
              <Field label="Industry"><Input value={form.industry} onChange={(e) => set("industry", e.target.value)} placeholder="Marketing agency" /></Field>
              <Field label="Logo URL" hint="Paste a hosted image URL; shown on proposals & contracts."><Input value={form.logoUrl} onChange={(e) => set("logoUrl", e.target.value)} placeholder="https://…/logo.png" /></Field>
              <Field label="Website"><Input value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://acme.com" /></Field>
              <Field label="Contact email"><Input value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} placeholder="hello@acme.com" /></Field>
              <Field label="Contact phone"><Input value={form.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} placeholder="(555) 010-0100" /></Field>
            </div>
            <Field label="Company address"><Input value={form.companyAddress} onChange={(e) => set("companyAddress", e.target.value)} placeholder="123 Main St, City, ST" /></Field>
            <Field label="Business description" hint="A sentence or two on what you do."><Textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={3} /></Field>
          </>
        )}

        {step === 1 && (
          <>
            <SectionTitle>Services & offers</SectionTitle>
            <Field label="What do you sell?">
              <Select value={form.sells} onChange={(e) => set("sells", e.target.value as SellsType)}>
                <option value="services">Services</option>
                <option value="software">Software / products</option>
                <option value="both">Both</option>
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Services offered" hint="One per line works well."><Textarea value={form.services} onChange={(e) => set("services", e.target.value)} rows={4} /></Field>
              <Field label="Software / products offered"><Textarea value={form.software} onChange={(e) => set("software", e.target.value)} rows={4} /></Field>
            </div>
            <Field label="Target customers"><Input value={form.targetCustomers} onChange={(e) => set("targetCustomers", e.target.value)} placeholder="Local service businesses, 5–50 staff" /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Scope of work"><Textarea value={form.scopeOfWork} onChange={(e) => set("scopeOfWork", e.target.value)} rows={3} /></Field>
              <Field label="Deliverables"><Textarea value={form.deliverables} onChange={(e) => set("deliverables", e.target.value)} rows={3} /></Field>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <SectionTitle>Pricing & packages</SectionTitle>
            <Field label="Pricing model"><Input value={form.pricingModel} onChange={(e) => set("pricingModel", e.target.value)} placeholder="Monthly retainer + setup" /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Setup fees"><Input value={form.setupFees} onChange={(e) => set("setupFees", e.target.value)} placeholder="$1,000 one-time" /></Field>
              <Field label="Monthly fees"><Input value={form.monthlyFees} onChange={(e) => set("monthlyFees", e.target.value)} placeholder="$2,500 / month" /></Field>
            </div>
            <Field label="Packages / plans" hint="Describe tiers, what's included."><Textarea value={form.packages} onChange={(e) => set("packages", e.target.value)} rows={4} /></Field>
            <Field label="Timeline"><Input value={form.timeline} onChange={(e) => set("timeline", e.target.value)} placeholder="Onboarding in 2 weeks; first results in 90 days" /></Field>
          </>
        )}

        {step === 3 && (
          <>
            <SectionTitle>Terms & policies</SectionTitle>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Payment terms"><Textarea value={form.paymentTerms} onChange={(e) => set("paymentTerms", e.target.value)} rows={2} placeholder="Net 15; auto-billed monthly" /></Field>
              <Field label="Contract length"><Input value={form.contractLength} onChange={(e) => set("contractLength", e.target.value)} placeholder="12 months, then month-to-month" /></Field>
              <Field label="Cancellation terms"><Textarea value={form.cancellationTerms} onChange={(e) => set("cancellationTerms", e.target.value)} rows={2} /></Field>
              <Field label="Refund terms"><Textarea value={form.refundTerms} onChange={(e) => set("refundTerms", e.target.value)} rows={2} /></Field>
            </div>
            <Field label="Guarantees / disclaimers"><Textarea value={form.guarantees} onChange={(e) => set("guarantees", e.target.value)} rows={2} /></Field>
            <Field label="Legal language to include" hint="Any clauses you always want present."><Textarea value={form.legalLanguage} onChange={(e) => set("legalLanguage", e.target.value)} rows={3} /></Field>
          </>
        )}

        {step === 4 && (
          <>
            <SectionTitle>Branding & tone</SectionTitle>
            <Field label="Brand tone" hint="Drives the voice of AI-generated copy."><Input value={form.brandTone} onChange={(e) => set("brandTone", e.target.value)} placeholder="confident, friendly, plain-spoken" /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Proposal style">
                <Select value={form.proposalStyle} onChange={(e) => set("proposalStyle", e.target.value as DocumentStyle)}>
                  {DOCUMENT_STYLES.map((s) => <option key={s} value={s}>{STYLE_LABELS[s]}</option>)}
                </Select>
              </Field>
              <Field label="Contract style">
                <Select value={form.contractStyle} onChange={(e) => set("contractStyle", e.target.value as DocumentStyle)}>
                  {DOCUMENT_STYLES.map((s) => <option key={s} value={s}>{STYLE_LABELS[s]}</option>)}
                </Select>
              </Field>
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <SectionTitle>Review & save</SectionTitle>
            <p className="text-sm text-slate-500">
              Saving stores your business profile for this account. You can then create proposal and contract templates —
              manually or with AI — and the details below fill in merge fields automatically.
            </p>
            <div className="grid gap-x-6 gap-y-2 rounded-lg border border-slate-200 p-4 text-sm dark:border-slate-700 sm:grid-cols-2">
              {([
                ["Business", form.businessName || "—"],
                ["Industry", form.industry || "—"],
                ["Sells", form.sells],
                ["Setup fees", form.setupFees || "—"],
                ["Monthly fees", form.monthlyFees || "—"],
                ["Contract length", form.contractLength || "—"],
                ["Brand tone", form.brandTone || "—"],
                ["Proposal / contract style", `${STYLE_LABELS[form.proposalStyle]} / ${STYLE_LABELS[form.contractStyle]}`],
              ] as const).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 border-b border-dashed border-slate-100 py-1 last:border-0 dark:border-slate-800">
                  <span className="text-slate-400">{k}</span>
                  <span className="text-right font-medium text-slate-700 dark:text-slate-200">{v}</span>
                </div>
              ))}
            </div>
            {error && <p className="text-sm text-rose-600">{error}</p>}
          </>
        )}
      </div>

      {/* Footer nav */}
      <div className="flex items-center justify-between border-t border-slate-200 px-5 py-4 dark:border-slate-700">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <div className="flex items-center gap-2">
          {step > 0 && (
            <Button variant="secondary" onClick={prev}><ArrowLeft className="h-4 w-4" /> Back</Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={next}>Next <ArrowRight className="h-4 w-4" /></Button>
          ) : (
            <Button variant="primary" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save profile
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
