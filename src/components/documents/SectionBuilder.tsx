// ============================================================================
// SectionBuilder — the visual proposal/contract editor. Documents are built from
// reorderable sections (NOT a textarea): add a typed section, edit its title +
// body, move it up/down, delete it, and insert merge-field tokens from a palette.
// When AI is enabled + configured it can generate a whole document, a single
// section, or follow-up email copy server-side. A live, client-facing preview
// renders alongside so the author always sees the finished look.
// ============================================================================

import { useMemo, useRef, useState } from "react";
import {
  Plus, Trash2, ChevronUp, ChevronDown, Sparkles, Loader2, Eye, Save, X, Copy, Check,
} from "lucide-react";
import { Card, Button, Badge, SectionTitle, EmptyState } from "../ui";
import { Field, Input, Textarea, Select } from "../ui/form";

// Same look as the UI-kit <Textarea>, but a native element so we can attach a
// ref and insert merge-field tokens at the caret position.
const TEXTAREA_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 resize-y";
import { Modal } from "../ui/Modal";
import {
  SECTION_LABELS, sectionTypesForKind, DOCUMENT_STYLES, STYLE_LABELS,
  MERGE_FIELDS, emptySection, sectionId, buildMergeContext, applySectionsMerge,
} from "../../lib/documents";
import { aiGenerate } from "../../lib/resource-client";
import { DocumentPreview } from "./DocumentPreview";
import type {
  DocumentSection, DocumentKind, DocumentStyle, SectionType, BusinessProfile,
} from "../../types";

export interface BuilderSavePayload {
  name: string;
  style: DocumentStyle;
  sections: DocumentSection[];
}

export function SectionBuilder({
  kind,
  scope,
  initialName,
  initialStyle,
  initialSections,
  business,
  ai,
  onSave,
  onCancel,
}: {
  kind: DocumentKind;
  scope: "template" | "document";
  initialName: string;
  initialStyle: DocumentStyle;
  initialSections: DocumentSection[];
  business: BusinessProfile | null;
  ai: { enabled: boolean; configured: boolean };
  onSave: (payload: BuilderSavePayload) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [style, setStyle] = useState<DocumentStyle>(initialStyle);
  const [sections, setSections] = useState<DocumentSection[]>(
    initialSections.length ? initialSections : [],
  );
  const [addType, setAddType] = useState<SectionType>(kind === "contract" ? "scope" : "solution");
  const [focused, setFocused] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AI panel state
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstr, setAiInstr] = useState("");
  const [aiSectionType, setAiSectionType] = useState<SectionType>(kind === "contract" ? "scope" : "solution");
  const [aiBusy, setAiBusy] = useState<"" | "doc" | "section" | "email">("");
  const [aiError, setAiError] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const sectionRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const types = useMemo(() => sectionTypesForKind(kind), [kind]);

  // ---- section ops (local working state; saved as a whole) ----
  const addSection = () => setSections((s) => [...s, emptySection(addType)]);
  const removeSection = (id: string) => setSections((s) => s.filter((x) => x.id !== id));
  const patch = (id: string, p: Partial<DocumentSection>) =>
    setSections((s) => s.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const move = (id: string, dir: -1 | 1) =>
    setSections((s) => {
      const i = s.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.length) return s;
      const out = [...s];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });

  /** Insert a merge token into the focused section (or the first one). */
  const insertMerge = (token: string) => {
    const targetId = focused ?? sections[0]?.id;
    if (!targetId) return;
    const el = sectionRefs.current[targetId];
    const cur = sections.find((x) => x.id === targetId)?.content ?? "";
    if (el && typeof el.selectionStart === "number") {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const nextVal = cur.slice(0, start) + `{{${token}}}` + cur.slice(end);
      patch(targetId, { content: nextVal });
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length + 4;
        el.setSelectionRange(pos, pos);
      });
    } else {
      patch(targetId, { content: `${cur}{{${token}}}` });
    }
  };

  // ---- AI ----
  const aiUsable = ai.enabled && ai.configured;
  function aiMessage(e: any): string {
    const m = e?.message ?? "";
    if (m === "ai_not_configured") return "AI is not configured. Add an OpenAI API key on the server to enable generation.";
    if (m === "ai_disabled") return "AI generation is turned off for this account.";
    if (m === "ai_timeout") return "The AI request timed out. Try again.";
    return "AI generation failed. Try again in a moment.";
  }

  async function generateDoc() {
    if (sections.length && !confirm("Replace the current sections with AI-generated ones?")) return;
    setAiBusy("doc");
    setAiError(null);
    try {
      const res = await aiGenerate({ kind, target: scope === "document" ? "document" : "template", instructions: aiInstr });
      setSections(res.sections);
      if (res.title && !name.trim()) setName(res.title);
      setAiOpen(false);
    } catch (e) {
      setAiError(aiMessage(e));
    } finally {
      setAiBusy("");
    }
  }

  async function generateSection() {
    setAiBusy("section");
    setAiError(null);
    try {
      const res = await aiGenerate({ kind, target: "section", sectionType: aiSectionType, instructions: aiInstr });
      const incoming = res.sections.length ? res.sections : [];
      setSections((s) => [...s, ...incoming.map((x) => ({ ...x, id: sectionId() }))]);
      setAiOpen(false);
    } catch (e) {
      setAiError(aiMessage(e));
    } finally {
      setAiBusy("");
    }
  }

  async function generateEmail() {
    setAiBusy("email");
    setAiError(null);
    try {
      const res = await aiGenerate({ kind, target: "email", instructions: aiInstr });
      const text = res.sections.map((s) => s.content).filter(Boolean).join("\n\n");
      setEmailDraft(text || "(empty)");
    } catch (e) {
      setAiError(aiMessage(e));
    } finally {
      setAiBusy("");
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), style, sections });
    } catch (e: any) {
      const m = e?.message ?? "";
      setError(
        m === "forbidden" ? "You don't have permission to save this."
        : m === "proposals_disabled" ? "Proposals are turned off for this account."
        : m === "contracts_disabled" ? "Contracts are turned off for this account."
        : "Could not save. Check your connection and try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  // Live preview uses business branding; client tokens show as [Client …] here.
  const previewSections = useMemo(
    () => applySectionsMerge(sections, buildMergeContext({ business })),
    [sections, business],
  );
  const branding = business
    ? {
        businessName: business.businessName, logoUrl: business.logoUrl, website: business.website,
        companyAddress: business.companyAddress, contactEmail: business.contactEmail,
        contactPhone: business.contactPhone, brandTone: business.brandTone,
      }
    : null;

  const nameLabel = scope === "document" ? "Document title" : "Template name";

  return (
    <div className="space-y-4">
      {/* Header controls */}
      <Card>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid flex-1 gap-4 sm:grid-cols-2">
            <Field label={nameLabel}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "contract" ? "Service Agreement" : "Service Proposal"} />
            </Field>
            <Field label="Style">
              <Select value={style} onChange={(e) => setStyle(e.target.value as DocumentStyle)}>
                {DOCUMENT_STYLES.map((s) => <option key={s} value={s}>{STYLE_LABELS[s]}</option>)}
              </Select>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={kind === "contract" ? "violet" : "blue"}>{kind === "contract" ? "Contract" : "Proposal"}</Badge>
            {ai.enabled && (
              <Button variant="secondary" onClick={() => { setAiOpen(true); setAiError(null); }}>
                <Sparkles className="h-4 w-4" /> AI assist
              </Button>
            )}
            <Button variant="secondary" onClick={() => setShowPreview(true)}><Eye className="h-4 w-4" /> Preview</Button>
            <Button variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
            </Button>
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
        {kind === "contract" && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            Generated contracts are templates and should be reviewed by a qualified professional before real use.
          </p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Sections editor */}
        <div className="space-y-3">
          {sections.length === 0 && (
            <EmptyState
              icon={<Plus className="h-5 w-5" />}
              title="No sections yet"
              description="Add a section below, or use AI assist to generate a full draft you can edit."
            />
          )}
          {sections.map((s, i) => (
            <Card key={s.id} className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <Select
                  value={s.type}
                  onChange={(e) => patch(s.id, { type: e.target.value as SectionType })}
                  className="max-w-[200px]"
                >
                  {types.map((t) => <option key={t} value={t}>{SECTION_LABELS[t]}</option>)}
                </Select>
                <div className="ml-auto flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => move(s.id, -1)} disabled={i === 0} aria-label="Move up"><ChevronUp className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="sm" onClick={() => move(s.id, 1)} disabled={i === sections.length - 1} aria-label="Move down"><ChevronDown className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="sm" onClick={() => removeSection(s.id)} aria-label="Delete section"><Trash2 className="h-4 w-4 text-rose-500" /></Button>
                </div>
              </div>
              <Field label="Heading"><Input value={s.title} onChange={(e) => patch(s.id, { title: e.target.value })} /></Field>
              <Field label="Content" className="mt-3">
                <textarea
                  rows={5}
                  className={TEXTAREA_CLASS}
                  value={s.content}
                  ref={(el) => { sectionRefs.current[s.id] = el; }}
                  onFocus={() => setFocused(s.id)}
                  onChange={(e) => patch(s.id, { content: e.target.value })}
                  placeholder="Write this section. Use the merge fields on the right to insert client/business details."
                />
              </Field>
            </Card>
          ))}

          {/* Add section */}
          <Card className="flex flex-wrap items-end gap-3 p-4">
            <Field label="Add a section" className="flex-1">
              <Select value={addType} onChange={(e) => setAddType(e.target.value as SectionType)}>
                {types.map((t) => <option key={t} value={t}>{SECTION_LABELS[t]}</option>)}
              </Select>
            </Field>
            <Button variant="secondary" onClick={addSection}><Plus className="h-4 w-4" /> Add section</Button>
          </Card>
        </div>

        {/* Merge field palette */}
        <div className="space-y-3">
          <Card>
            <SectionTitle>Merge fields</SectionTitle>
            <p className="mb-3 mt-1 text-xs text-slate-500">
              Click to insert into the section you're editing. Tokens are replaced with real values when you create a document for a client; a missing value shows a clear placeholder.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {MERGE_FIELDS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => insertMerge(f.key)}
                  className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                  title={`Insert {{${f.key}}}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </Card>
          {!business && (
            <Card className="border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10">
              <p className="text-xs text-amber-800 dark:text-amber-300">
                Tip: complete the AI Business Setup first so your logo, contact details, and terms fill in automatically.
              </p>
            </Card>
          )}
        </div>
      </div>

      {/* AI assist modal */}
      <Modal open={aiOpen} onClose={() => setAiOpen(false)} title="AI assist" size="lg"
        footer={<Button variant="ghost" onClick={() => setAiOpen(false)}>Close</Button>}>
        {!aiUsable ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
            {ai.enabled
              ? "AI is not configured. Add an OpenAI API key on the server to enable generation. Manual editing keeps working without it."
              : "AI generation is turned off for this account by your administrator."}
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Instructions (optional)" hint="E.g. emphasize speed and a 90-day guarantee.">
              <Textarea value={aiInstr} onChange={(e) => setAiInstr(e.target.value)} rows={3} />
            </Field>
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <div className="flex-1">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Generate a full {kind}</p>
                <p className="text-xs text-slate-500">Replaces the current sections with a structured draft.</p>
              </div>
              <Button variant="primary" onClick={generateDoc} disabled={aiBusy !== ""}>
                {aiBusy === "doc" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Generate {kind}
              </Button>
            </div>
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <Field label="Generate one section" className="flex-1">
                <Select value={aiSectionType} onChange={(e) => setAiSectionType(e.target.value as SectionType)}>
                  {types.map((t) => <option key={t} value={t}>{SECTION_LABELS[t]}</option>)}
                </Select>
              </Field>
              <Button variant="secondary" onClick={generateSection} disabled={aiBusy !== ""}>
                {aiBusy === "section" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add section
              </Button>
            </div>
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <div className="flex-1">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Draft a follow-up email</p>
                <p className="text-xs text-slate-500">Copy to send after this {kind} goes out.</p>
              </div>
              <Button variant="secondary" onClick={generateEmail} disabled={aiBusy !== ""}>
                {aiBusy === "email" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Draft email
              </Button>
            </div>
            {aiError && <p className="text-sm text-rose-600">{aiError}</p>}
            {emailDraft != null && (
              <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Follow-up email</span>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => { navigator.clipboard?.writeText(emailDraft); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                      {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEmailDraft(null)} aria-label="Dismiss"><X className="h-4 w-4" /></Button>
                  </div>
                </div>
                <p className="whitespace-pre-line text-sm text-slate-600 dark:text-slate-300">{emailDraft}</p>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Live preview modal */}
      <Modal open={showPreview} onClose={() => setShowPreview(false)} title="Preview" size="xl"
        footer={<Button variant="primary" onClick={() => setShowPreview(false)}>Done</Button>}>
        <div className="rounded-xl bg-white p-6 shadow-inner dark:bg-slate-950">
          <DocumentPreview kind={kind} title={name} style={style} sections={previewSections} branding={branding} />
        </div>
      </Modal>
    </div>
  );
}
