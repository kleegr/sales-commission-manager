// ============================================================================
// DOCUMENTS — Proposals & Contracts center
//
// One page, three modes (no extra routes): a home with tabbed lists, the AI
// Business Setup wizard, and the visual section builder. Proposals and
// contracts are built from reorderable, typed sections with merge fields and a
// live client-facing preview — never a raw textarea.
//
// Everything is tenant-scoped on the server (/api/documents, /api/business-
// profile, /api/ai). Self roles only ever see their own clients' documents.
// Tabs and AI controls respect the tenant feature flags (proposals / contracts
// / ai); if both proposals and contracts are off, the page shows a blocked
// state. AI is optional: when no OpenAI key is configured, manual building
// keeps working and the assist panel explains it's unavailable.
//
// Lifecycle: Draft -> Sent -> Viewed -> Signed (or Canceled, then re-openable).
// E-signature is intentionally NOT wired up — this manages status only.
// ============================================================================

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  FileText, FileSignature, Sparkles, Plus, Eye, Pencil, Copy, Trash2,
  Send, CheckCircle2, XCircle, Loader2, Building2, History, ArrowLeft,
  RotateCcw, Lock,
} from "lucide-react";
import { useApp } from "../store/AppContext";
import { useFeatures } from "../store/FeaturesContext";
import {
  PageHeader, Card, Button, Badge, SectionTitle, EmptyState,
  Field, Input, Select, Table, THead, TBody, TR, TH, TD,
} from "../components/ui";
import { Modal } from "../components/ui/Modal";
import { formatCurrency, formatDate } from "../lib/format";
import {
  STATUS_LABELS, NEXT_STATUS, isTerminalStatus, STYLE_LABELS, defaultSections,
} from "../lib/documents";
import {
  listDocuments, getBusinessProfile, aiStatus, listAiHistory,
  createTemplate, updateTemplate, duplicateTemplate, deleteTemplate,
  createClientDocument, updateClientDocument, setDocumentStatus, previewDocument,
  type PreviewResponse,
} from "../lib/resource-client";
import { BusinessWizard } from "../components/documents/BusinessWizard";
import { SectionBuilder, type BuilderSavePayload } from "../components/documents/SectionBuilder";
import { DocumentPreview, type PreviewBranding } from "../components/documents/DocumentPreview";
import type {
  BusinessProfile, ClientDocument, DocumentTemplate, AiGeneration,
  DocumentKind, DocStatus, DocumentStyle, DocumentSection,
} from "../types";

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

const STATUS_TONE: Record<DocStatus, "slate" | "blue" | "violet" | "green" | "rose"> = {
  draft: "slate", sent: "blue", viewed: "violet", signed: "green", canceled: "rose",
};

function DocStatusBadge({ status }: { status: DocStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>;
}

const ERROR_LABELS: Record<string, string> = {
  forbidden: "You don't have permission to do that.",
  proposals_disabled: "Proposals are turned off for this workspace.",
  contracts_disabled: "Contracts are turned off for this workspace.",
  ai_disabled: "AI is turned off for this workspace.",
  ai_not_configured: "AI isn't configured on the server yet.",
  invalid_transition: "That status change isn't allowed.",
};

function msgOf(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : "";
  return ERROR_LABELS[m] ?? (m || fallback);
}

function brandingFromProfile(p: BusinessProfile | null, fallbackName: string): PreviewBranding {
  return {
    businessName: p?.businessName || fallbackName,
    logoUrl: p?.logoUrl ?? "",
    website: p?.website ?? "",
    companyAddress: p?.companyAddress ?? "",
    contactEmail: p?.contactEmail ?? "",
    contactPhone: p?.contactPhone ?? "",
    brandTone: p?.brandTone,
  };
}

// ----------------------------------------------------------------------------
// View state
// ----------------------------------------------------------------------------

type Tab =
  | "business"
  | "proposalTemplates"
  | "contractTemplates"
  | "proposalDocs"
  | "contractDocs"
  | "ai";

interface BuilderCtx {
  scope: "template" | "document";
  kind: DocumentKind;
  id: string;
  title: string;
  style: DocumentStyle;
  sections: DocumentSection[];
  subtitle?: string;
}

type View =
  | { mode: "home" }
  | { mode: "wizard" }
  | { mode: "builder"; ctx: BuilderCtx };

// ============================================================================
// Page
// ============================================================================

export default function Documents() {
  const { data } = useApp();
  const { isEnabled } = useFeatures();

  const clients = data.clients;
  const companyName = data.settings.companyName;

  const proposalsOn = isEnabled("proposals");
  const contractsOn = isEnabled("contracts");
  const aiOn = isEnabled("ai");

  const [view, setView] = useState<View>({ mode: "home" });
  const [tab, setTab] = useState<Tab>(
    proposalsOn ? "proposalTemplates" : contractsOn ? "contractTemplates" : "business",
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [documents, setDocuments] = useState<ClientDocument[]>([]);
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [ai, setAi] = useState<{ configured: boolean; model: string }>({ configured: false, model: "" });
  const [history, setHistory] = useState<AiGeneration[]>([]);

  // create-for-client modal
  const [createKind, setCreateKind] = useState<DocumentKind | null>(null);
  const [cTemplateId, setCTemplateId] = useState("");
  const [cClientId, setCClientId] = useState("");
  const [cTitle, setCTitle] = useState("");
  const [creating, setCreating] = useState(false);

  // preview modal
  const [previewData, setPreviewData] = useState<PreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  // ---- data loading --------------------------------------------------------

  const refreshLists = useCallback(async () => {
    const docs = await listDocuments({});
    setTemplates(docs.templates);
    setDocuments(docs.documents);
    return docs;
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [docs, prof, aist] = await Promise.all([
        listDocuments({}),
        getBusinessProfile().catch(() => null),
        aiStatus().catch(() => ({ configured: false, model: "" })),
      ]);
      setTemplates(docs.templates);
      setDocuments(docs.documents);
      setProfile(prof);
      setAi(aist);
    } catch (e) {
      setError(msgOf(e, "Failed to load documents."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (tab === "ai" && aiOn) {
      listAiHistory().then(setHistory).catch(() => setHistory([]));
    }
  }, [tab, aiOn]);

  // ---- derived -------------------------------------------------------------

  const proposalTemplates = useMemo(() => templates.filter((t) => t.kind === "proposal"), [templates]);
  const contractTemplates = useMemo(() => templates.filter((t) => t.kind === "contract"), [templates]);
  const proposalDocs = useMemo(() => documents.filter((d) => d.kind === "proposal"), [documents]);
  const contractDocs = useMemo(() => documents.filter((d) => d.kind === "contract"), [documents]);

  const clientName = useCallback(
    (id: string | null) => clients.find((c) => c.id === id)?.companyName ?? "—",
    [clients],
  );

  // ---- template actions ----------------------------------------------------

  function openTemplateBuilder(t: DocumentTemplate) {
    setView({
      mode: "builder",
      ctx: {
        scope: "template", kind: t.kind, id: t.id, title: t.name,
        style: t.style, sections: t.sections,
        subtitle: t.isDefault ? "Default template" : undefined,
      },
    });
  }

  async function newTemplate(kind: DocumentKind) {
    setError(null);
    try {
      const { id } = await createTemplate({
        kind,
        name: kind === "proposal" ? "New proposal template" : "New contract template",
        sections: defaultSections(kind),
      });
      const docs = await refreshLists();
      const t = docs.templates.find((x) => x.id === id);
      if (t) openTemplateBuilder(t);
    } catch (e) {
      setError(msgOf(e, "Could not create the template."));
    }
  }

  async function onDuplicate(t: DocumentTemplate) {
    setError(null);
    try {
      await duplicateTemplate(t.id);
      await refreshLists();
    } catch (e) {
      setError(msgOf(e, "Could not duplicate the template."));
    }
  }

  async function onDeleteTemplate(t: DocumentTemplate) {
    if (!window.confirm(`Delete the template "${t.name}"? This can't be undone.`)) return;
    setError(null);
    try {
      await deleteTemplate(t.id);
      await refreshLists();
    } catch (e) {
      setError(msgOf(e, "Could not delete the template."));
    }
  }

  // ---- client document actions ---------------------------------------------

  function openCreateModal(kind: DocumentKind) {
    setCreateKind(kind);
    const first = (kind === "proposal" ? proposalTemplates : contractTemplates)[0];
    setCTemplateId(first?.id ?? "");
    setCClientId(clients[0]?.id ?? "");
    setCTitle("");
  }

  function openDocumentBuilder(d: ClientDocument) {
    setView({
      mode: "builder",
      ctx: {
        scope: "document", kind: d.kind, id: d.id, title: d.title,
        style: d.style, sections: d.sections,
        subtitle: d.clientId ? `For ${clientName(d.clientId)}` : undefined,
      },
    });
  }

  async function submitCreate() {
    if (!createKind) return;
    setCreating(true);
    setError(null);
    try {
      const { id } = await createClientDocument({
        kind: createKind,
        clientId: cClientId || null,
        templateId: cTemplateId || null,
        title: cTitle.trim() || undefined,
      });
      const docs = await refreshLists();
      const d = docs.documents.find((x) => x.id === id);
      setCreateKind(null);
      if (d) openDocumentBuilder(d);
    } catch (e) {
      setError(msgOf(e, "Could not create the document."));
    } finally {
      setCreating(false);
    }
  }

  async function changeStatus(d: ClientDocument, status: DocStatus) {
    setError(null);
    try {
      await setDocumentStatus(d.id, status);
      await refreshLists();
    } catch (e) {
      setError(msgOf(e, "Could not update the status."));
    }
  }

  // ---- builder save --------------------------------------------------------

  async function handleBuilderSave(ctx: BuilderCtx, payload: BuilderSavePayload) {
    if (ctx.scope === "template") {
      await updateTemplate(ctx.id, {
        name: payload.name, style: payload.style, sections: payload.sections,
      });
    } else {
      await updateClientDocument(ctx.id, {
        title: payload.name, style: payload.style, sections: payload.sections,
      });
    }
    await refreshLists();
    setView({ mode: "home" });
  }

  // ---- preview -------------------------------------------------------------

  async function openPreview(scope: "template" | "document", id: string, clientId?: string | null) {
    setPreviewBusy(true);
    setError(null);
    try {
      const d = await previewDocument(scope, id, clientId ?? null);
      setPreviewData(d);
    } catch (e) {
      setError(msgOf(e, "Could not generate a preview."));
    } finally {
      setPreviewBusy(false);
    }
  }

  // ==========================================================================
  // Blocked: neither proposals nor contracts enabled
  // ==========================================================================

  if (!proposalsOn && !contractsOn) {
    return (
      <div className="space-y-6">
        <PageHeader title="Documents" subtitle="Proposals & contracts" />
        <Card className="py-12">
          <EmptyState
            icon={<Lock className="h-6 w-6" />}
            title="Documents are turned off"
            description="Proposals and contracts are disabled for this workspace. An owner or admin can enable them under Settings → Features."
          />
        </Card>
      </div>
    );
  }

  // ==========================================================================
  // Wizard mode
  // ==========================================================================

  if (view.mode === "wizard") {
    return (
      <div className="space-y-5">
        <BackBar label="Back to documents" onBack={() => setView({ mode: "home" })} />
        <BusinessWizard
          initial={profile}
          onSaved={(p) => { setProfile(p); setTab("business"); setView({ mode: "home" }); }}
          onCancel={() => setView({ mode: "home" })}
        />
      </div>
    );
  }

  // ==========================================================================
  // Builder mode
  // ==========================================================================

  if (view.mode === "builder") {
    const ctx = view.ctx;
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <BackBar label="Back to documents" onBack={() => setView({ mode: "home" })} />
          <div className="flex items-center gap-2 text-sm text-slate-500">
            {ctx.kind === "contract" ? <FileSignature className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
            <span className="capitalize">{ctx.kind}</span>
            <span className="text-slate-300">·</span>
            <span>{ctx.scope === "template" ? "Template" : "Client document"}</span>
            {ctx.subtitle && <><span className="text-slate-300">·</span><span>{ctx.subtitle}</span></>}
          </div>
        </div>
        <SectionBuilder
          kind={ctx.kind}
          scope={ctx.scope}
          initialName={ctx.title}
          initialStyle={ctx.style}
          initialSections={ctx.sections}
          business={profile}
          ai={{ enabled: aiOn, configured: ai.configured }}
          onSave={(payload) => handleBuilderSave(ctx, payload)}
          onCancel={() => setView({ mode: "home" })}
        />
      </div>
    );
  }

  // ==========================================================================
  // Home mode
  // ==========================================================================

  const allTabs: { id: Tab; label: string; icon: ReactNode; show: boolean }[] = [
    { id: "business", label: "Business Setup", icon: <Building2 className="h-4 w-4" />, show: true },
    { id: "proposalTemplates", label: "Proposal Templates", icon: <FileText className="h-4 w-4" />, show: proposalsOn },
    { id: "contractTemplates", label: "Contract Templates", icon: <FileSignature className="h-4 w-4" />, show: contractsOn },
    { id: "proposalDocs", label: "Client Proposals", icon: <FileText className="h-4 w-4" />, show: proposalsOn },
    { id: "contractDocs", label: "Client Contracts", icon: <FileSignature className="h-4 w-4" />, show: contractsOn },
    { id: "ai", label: "AI History", icon: <History className="h-4 w-4" />, show: aiOn },
  ];
  const tabs = allTabs.filter((t) => t.show);

  const activeTab: Tab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" onClick={() => setView({ mode: "wizard" })}>
        <Sparkles className="h-4 w-4" /> {profile ? "Edit business profile" : "Set up business"}
      </Button>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        subtitle="Build branded proposals and contracts from reusable sections."
        actions={headerActions}
      />

      {error && (
        <Card className="border-rose-200 bg-rose-50 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </Card>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              "flex items-center gap-2 rounded-t-lg px-3 py-2 text-sm font-medium transition " +
              (activeTab === t.id
                ? "border-b-2 border-brand-500 text-brand-700 dark:text-brand-300"
                : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200")
            }
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-16 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading documents…
        </div>
      ) : (
        <>
          {activeTab === "business" && (
            <BusinessPanel profile={profile} onEdit={() => setView({ mode: "wizard" })} />
          )}

          {activeTab === "proposalTemplates" && (
            <TemplateList
              kind="proposal"
              templates={proposalTemplates}
              onNew={() => newTemplate("proposal")}
              onEdit={openTemplateBuilder}
              onDuplicate={onDuplicate}
              onDelete={onDeleteTemplate}
              onPreview={(t) => openPreview("template", t.id)}
            />
          )}

          {activeTab === "contractTemplates" && (
            <TemplateList
              kind="contract"
              templates={contractTemplates}
              onNew={() => newTemplate("contract")}
              onEdit={openTemplateBuilder}
              onDuplicate={onDuplicate}
              onDelete={onDeleteTemplate}
              onPreview={(t) => openPreview("template", t.id)}
            />
          )}

          {activeTab === "proposalDocs" && (
            <ClientDocList
              kind="proposal"
              docs={proposalDocs}
              clientName={clientName}
              onNew={() => openCreateModal("proposal")}
              onEdit={openDocumentBuilder}
              onPreview={(d) => openPreview("document", d.id, d.clientId)}
              onStatus={changeStatus}
            />
          )}

          {activeTab === "contractDocs" && (
            <ClientDocList
              kind="contract"
              docs={contractDocs}
              clientName={clientName}
              onNew={() => openCreateModal("contract")}
              onEdit={openDocumentBuilder}
              onPreview={(d) => openPreview("document", d.id, d.clientId)}
              onStatus={changeStatus}
            />
          )}

          {activeTab === "ai" && (
            <AiHistoryPanel history={history} configured={ai.configured} model={ai.model} clientName={clientName} />
          )}
        </>
      )}

      {/* Create-for-client modal */}
      <Modal
        open={createKind !== null}
        onClose={() => setCreateKind(null)}
        title={`New ${createKind ?? ""} for a client`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateKind(null)}>Cancel</Button>
            <Button onClick={submitCreate} disabled={creating}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create &amp; edit
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Field label="Client" hint="Self-serve roles only see their own clients.">
            <Select value={cClientId} onChange={(e) => setCClientId(e.target.value)}>
              <option value="">— No client (generic) —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.companyName}</option>
              ))}
            </Select>
          </Field>
          <Field label="Start from template" hint="The template's sections are copied in; client details are merged automatically.">
            <Select value={cTemplateId} onChange={(e) => setCTemplateId(e.target.value)}>
              <option value="">— Blank starter —</option>
              {(createKind === "contract" ? contractTemplates : proposalTemplates).map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (default)" : ""}</option>
              ))}
            </Select>
          </Field>
          <Field label="Title" hint="Leave blank to auto-name from the client.">
            <Input value={cTitle} onChange={(e) => setCTitle(e.target.value)} placeholder={`${createKind === "contract" ? "Service Agreement" : "Proposal"}…`} />
          </Field>
        </div>
      </Modal>

      {/* Preview modal */}
      <Modal
        open={previewData !== null || previewBusy}
        onClose={() => setPreviewData(null)}
        title="Preview"
        size="xl"
      >
        {previewBusy && !previewData ? (
          <div className="flex items-center gap-2 py-12 text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" /> Building preview…
          </div>
        ) : previewData ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span>Status:</span>
              {previewData.status ? <DocStatusBadge status={previewData.status} /> : <Badge tone="slate">Template</Badge>}
            </div>
            <DocumentPreview
              kind={previewData.kind}
              title={previewData.title}
              style={previewData.style}
              sections={previewData.sections}
              branding={previewData.branding ?? brandingFromProfile(profile, companyName)}
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-800 dark:hover:text-slate-200"
    >
      <ArrowLeft className="h-4 w-4" /> {label}
    </button>
  );
}

function ContractNotice() {
  return (
    <Card className="border-amber-200 bg-amber-50 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
      Generated contracts are starting templates, not legal advice. Have a qualified professional review them before use.
    </Card>
  );
}

function BusinessPanel({ profile, onEdit }: { profile: BusinessProfile | null; onEdit: () => void }) {
  if (!profile || !profile.businessName) {
    return (
      <Card className="py-12">
        <EmptyState
          icon={<Building2 className="h-6 w-6" />}
          title="Set up your business profile"
          description="Tell the wizard about your services, pricing, and terms once. Those details flow into every proposal and contract — and power the AI drafts."
          action={<Button onClick={onEdit}><Sparkles className="h-4 w-4" /> Start setup</Button>}
        />
      </Card>
    );
  }

  const rows: { label: string; value: string }[] = [
    { label: "Business", value: profile.businessName },
    { label: "Industry", value: profile.industry },
    { label: "Sells", value: profile.sells },
    { label: "Website", value: profile.website },
    { label: "Setup fees", value: profile.setupFees },
    { label: "Monthly fees", value: profile.monthlyFees },
    { label: "Payment terms", value: profile.paymentTerms },
    { label: "Contract length", value: profile.contractLength },
    { label: "Brand tone", value: profile.brandTone },
    { label: "Proposal style", value: STYLE_LABELS[profile.proposalStyle as DocumentStyle] ?? profile.proposalStyle },
    { label: "Contract style", value: STYLE_LABELS[profile.contractStyle as DocumentStyle] ?? profile.contractStyle },
  ].filter((r) => r.value && r.value.trim());

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionTitle>Business profile</SectionTitle>
        <Button variant="secondary" onClick={onEdit}><Pencil className="h-4 w-4" /> Edit</Button>
      </div>
      <Card>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          {rows.map((r) => (
            <div key={r.label} className="flex flex-col">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{r.label}</dt>
              <dd className="text-sm text-slate-800 dark:text-slate-200">{r.value}</dd>
            </div>
          ))}
        </dl>
        {profile.description && (
          <p className="mt-4 border-t border-slate-100 pt-4 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-400">
            {profile.description}
          </p>
        )}
      </Card>
    </div>
  );
}

function TemplateList({
  kind, templates, onNew, onEdit, onDuplicate, onDelete, onPreview,
}: {
  kind: DocumentKind;
  templates: DocumentTemplate[];
  onNew: () => void;
  onEdit: (t: DocumentTemplate) => void;
  onDuplicate: (t: DocumentTemplate) => void;
  onDelete: (t: DocumentTemplate) => void;
  onPreview: (t: DocumentTemplate) => void;
}) {
  const label = kind === "contract" ? "contract" : "proposal";
  return (
    <div className="space-y-4">
      {kind === "contract" && <ContractNotice />}
      <div className="flex items-center justify-between">
        <SectionTitle>{kind === "contract" ? "Contract templates" : "Proposal templates"}</SectionTitle>
        <Button onClick={onNew}><Plus className="h-4 w-4" /> New template</Button>
      </div>

      {templates.length === 0 ? (
        <Card className="py-10">
          <EmptyState
            icon={kind === "contract" ? <FileSignature className="h-6 w-6" /> : <FileText className="h-6 w-6" />}
            title={`No ${label} templates yet`}
            description={`Create a reusable ${label} with typed sections and merge fields. You'll start from a sensible default you can edit.`}
            action={<Button onClick={onNew}><Plus className="h-4 w-4" /> New template</Button>}
          />
        </Card>
      ) : (
        <Card className="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Style</TH>
                <TH>Sections</TH>
                <TH>Updated</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {templates.map((t) => (
                <TR key={t.id}>
                  <TD>
                    <div className="font-medium text-slate-800 dark:text-slate-100">{t.name}</div>
                    {t.isDefault && <Badge tone="blue">Default</Badge>}
                  </TD>
                  <TD>{STYLE_LABELS[t.style] ?? t.style}</TD>
                  <TD>{t.sections.length}</TD>
                  <TD className="text-slate-500">{formatDate(t.updatedAt)}</TD>
                  <TD>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => onPreview(t)} aria-label="Preview"><Eye className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="sm" onClick={() => onEdit(t)} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="sm" onClick={() => onDuplicate(t)} aria-label="Duplicate"><Copy className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(t)} aria-label="Delete"><Trash2 className="h-4 w-4 text-rose-500" /></Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function ClientDocList({
  kind, docs, clientName, onNew, onEdit, onPreview, onStatus,
}: {
  kind: DocumentKind;
  docs: ClientDocument[];
  clientName: (id: string | null) => string;
  onNew: () => void;
  onEdit: (d: ClientDocument) => void;
  onPreview: (d: ClientDocument) => void;
  onStatus: (d: ClientDocument, status: DocStatus) => void;
}) {
  const label = kind === "contract" ? "contract" : "proposal";
  return (
    <div className="space-y-4">
      {kind === "contract" && <ContractNotice />}
      <div className="flex items-center justify-between">
        <SectionTitle>{kind === "contract" ? "Client contracts" : "Client proposals"}</SectionTitle>
        <Button onClick={onNew}><Plus className="h-4 w-4" /> Create for client</Button>
      </div>

      {docs.length === 0 ? (
        <Card className="py-10">
          <EmptyState
            icon={kind === "contract" ? <FileSignature className="h-6 w-6" /> : <FileText className="h-6 w-6" />}
            title={`No ${label}s yet`}
            description={`Create a ${label} for a specific client. Their details merge in automatically, and you can edit every section before sending.`}
            action={<Button onClick={onNew}><Plus className="h-4 w-4" /> Create for client</Button>}
          />
        </Card>
      ) : (
        <Card className="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Title</TH>
                <TH>Client</TH>
                <TH>Amount</TH>
                <TH>Status</TH>
                <TH>Updated</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {docs.map((d) => {
                const next = NEXT_STATUS[d.status];
                return (
                  <TR key={d.id}>
                    <TD className="font-medium text-slate-800 dark:text-slate-100">{d.title}</TD>
                    <TD>{clientName(d.clientId)}</TD>
                    <TD>{d.amount ? formatCurrency(d.amount) : "—"}</TD>
                    <TD><DocStatusBadge status={d.status} /></TD>
                    <TD className="text-slate-500">{formatDate(d.updatedAt)}</TD>
                    <TD>
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => onPreview(d)} aria-label="Preview"><Eye className="h-4 w-4" /></Button>
                        {!isTerminalStatus(d.status) && (
                          <Button variant="ghost" size="sm" onClick={() => onEdit(d)} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
                        )}
                        {next && (
                          <Button variant="subtle" size="sm" onClick={() => onStatus(d, next)}>
                            {next === "sent" ? <Send className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                            Mark {STATUS_LABELS[next].toLowerCase()}
                          </Button>
                        )}
                        {d.status === "canceled" ? (
                          <Button variant="ghost" size="sm" onClick={() => onStatus(d, "draft")}>
                            <RotateCcw className="h-4 w-4" /> Reopen
                          </Button>
                        ) : d.status !== "signed" ? (
                          <Button variant="ghost" size="sm" onClick={() => onStatus(d, "canceled")} aria-label="Cancel">
                            <XCircle className="h-4 w-4 text-rose-500" />
                          </Button>
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function AiHistoryPanel({
  history, configured, model, clientName,
}: {
  history: AiGeneration[];
  configured: boolean;
  model: string;
  clientName: (id: string | null) => string;
}) {
  return (
    <div className="space-y-4">
      <Card className={configured
        ? "border-brand-200 bg-brand-50/60 text-sm text-slate-700 dark:border-brand-900/40 dark:bg-brand-950/20 dark:text-slate-300"
        : "text-sm text-slate-600 dark:text-slate-400"}>
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand-500" />
          {configured
            ? <span>AI drafting is available{model ? <> · model <span className="font-medium">{model}</span></> : null}. Generate drafts from any section editor.</span>
            : <span>AI drafting isn't configured on the server. You can still build everything manually — set an OpenAI key to enable assists.</span>}
        </div>
      </Card>

      {history.length === 0 ? (
        <Card className="py-10">
          <EmptyState
            icon={<History className="h-6 w-6" />}
            title="No AI generations yet"
            description="When you use the AI assist inside the builder, each generation is logged here for your team."
          />
        </Card>
      ) : (
        <Card className="p-0">
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Kind</TH>
                <TH>Title</TH>
                <TH>Client</TH>
                <TH>Model</TH>
              </TR>
            </THead>
            <TBody>
              {history.map((h) => (
                <TR key={h.id}>
                  <TD className="text-slate-500">{formatDate(h.createdAt)}</TD>
                  <TD className="capitalize">{h.kind}</TD>
                  <TD className="font-medium text-slate-800 dark:text-slate-100">{h.title || "—"}</TD>
                  <TD>{clientName(h.clientId)}</TD>
                  <TD className="text-slate-500">{h.model || "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
