import {ProposalBuilder} from '../components/documents/ProposalBuilder';
import {ProposalSheet} from '../components/documents/ProposalSheet';
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
// FLOW 4: "Send" emails a private approval link (/p/<token>); the recipient
// approves + types a signature on the public page, which auto-creates the
// client (prospect mode), a won opportunity and a pending receipt for the
// salesperson. Manual "Mark …" status buttons remain as overrides.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FileText, FileSignature, Sparkles, Plus, Eye, Pencil, Copy, Trash2,
  Send, CheckCircle2, XCircle, Loader2, Building2, History, ArrowLeft,
  RotateCcw, Lock, Link2, UserPlus, Boxes, ExternalLink,
} from "lucide-react";
import { useApp } from "../store/AppContext";
import { useAuth } from "../store/AuthContext";
import { useFeatures } from "../store/FeaturesContext";
import { useTracker } from "../components/TrackerGate";
import { trackerGet } from "../lib/tracker-client";
import { SELF_ROLES } from "../lib/roles";
import { LineItemsEditor, type CatalogProduct } from "../components/documents/LineItems";
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
import {
  ShareDialog, LinkBanner, ProspectFields, ApprovalCard, emptyProspect, recipientOf, mintDocumentLink,
  type DocRow, type Prospect, type ShareResult,
} from "../components/documents/ProposalShare";
import type {
  BusinessProfile, ClientDocument, DocumentTemplate, AiGeneration,
  DocumentKind, DocStatus, DocumentStyle, DocumentSection,
  ClientDocKind, DocumentLineItem,
} from "../types";

// Document-type options for the sales-document family (proposal-shaped kinds).
const DOC_TYPE_LABELS: Record<ClientDocKind, string> = {
  proposal: "Proposal", contract: "Contract", quote: "Quote", invoice: "Invoice", payment_request: "Payment request",
};
const SALES_DOC_TYPES: ClientDocKind[] = ["proposal", "quote", "invoice", "payment_request"];

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
  price_below_floor: "A line item is priced below the product's floor. Raise the price to at least the product price.",
  product_not_assigned: "One of the products isn't assigned to you. Ask an admin to assign it, or remove it.",
  unknown_product: "A selected product no longer exists. Remove it and pick another.",
  invalid_campaign: "That campaign is no longer available.",
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
  const { user } = useAuth();
  const { workspace } = useTracker();
  const { isEnabled } = useFeatures();

  const clients = data.clients;
  const companyName = data.settings.companyName;
  const isSelf = SELF_ROLES.includes((user?.role ?? "salesperson") as never);
  const currency = workspace?.currency || "USD";
  const digits = workspace?.payout_terms?.minorDigits ?? 2;

  // Product catalog + campaigns for the line-item builder and campaign link.
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError,setCatalogError]=useState('');
  const [campaignOptions, setCampaignOptions] = useState<{ id: string; name: string }[]>([]);

  const proposalsOn = isEnabled("proposals");
  const contractsOn = isEnabled("contracts");
  const aiOn = isEnabled("ai");

  const [guided, setGuided] = useState<{existing?:DocRow}|null>(null);
  const [savedNotice,setSavedNotice]=useState('');
  const [view, setView] = useState<View>({ mode: "home" });
  const [tab, setTab] = useState<Tab>(
    proposalsOn ? "proposalDocs" : contractsOn ? "contractDocs" : "business",
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
  const [cMode, setCMode] = useState<"client" | "prospect">("client");
  const [cProspect, setCProspect] = useState<Prospect>(emptyProspect());
  const [cDocType, setCDocType] = useState<ClientDocKind>("proposal");
  const [cLineItems, setCLineItems] = useState<DocumentLineItem[]>([]);
  const [cCampaignId, setCCampaignId] = useState("");

  // edit pricing / line items on an existing document
  const [pricingDoc, setPricingDoc] = useState<DocRow | null>(null);

  // FLOW 4: share dialog + the one-time link banner
  const [shareDoc, setShareDoc] = useState<DocRow | null>(null);
  const [shareResult, setShareResult] = useState<ShareResult | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState('');
  const linkRequest = useRef(false);
  const sessionLinks = useRef(new Map<string, ShareResult>());

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
  useEffect(()=>{const refresh=()=>{if(document.visibilityState==='visible')void refreshLists().catch(()=>{});};const timer=window.setInterval(refresh,15000);window.addEventListener('focus',refresh);return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);};},[refreshLists]);

  // Load the product catalog (self roles see only their assigned products) + campaigns.
  useEffect(() => {
    let live = true;
    (async () => {
      setCatalogLoading(true);
      setCatalogError('');
      const allRows=async(resource:string,filters:Record<string,string>={})=>{
        let rows:any[]=[];let page=1;
        for(;;){const result=await trackerGet(resource,{...filters,limit:'100',page:String(page)});const batch=result.rows||[];rows.push(...batch);if(!batch.length||rows.length>=Number(result.total??rows.length))return {rows};page++;}
      };
      try {
        const [prods, camps] = await Promise.all([
          allRows("products", {status: "active"}),
          allRows("campaigns"),
        ]);
        let rows = (prods.rows ?? []) as any[];
        if (isSelf && user?.salespersonId) {
          const asg = await trackerGet("productAssignments", { salespersonId: user.salespersonId }).catch(() => ({ rows: [] }));
          const allowed = new Set((asg.rows ?? []).map((r: any) => r.product_id));
          rows = rows.filter((r) => allowed.has(r.id));
        }
        if (!live) return;
        setCatalog(rows.map((r) => ({ id: r.id, name: r.name, price_minor: String(r.price_minor), billing_kind: r.billing_kind, currency: r.currency, description:r.description, category:r.category, recurring_interval:r.recurring_interval, ghl_product_id:r.ghl_product_id })));
        setCampaignOptions((camps.rows ?? []).map((c: any) => ({ id: c.id, name: c.name })));
      } catch(e) {
        if(live)setCatalogError(e instanceof Error?e.message:"Could not load your catalog. Refresh to retry.");
      } finally {
        if (live) setCatalogLoading(false);
      }
    })();
    return () => { live = false; };
  }, [isSelf, user?.salespersonId, !!guided]);

  useEffect(() => {
    if (tab === "ai" && aiOn) {
      listAiHistory().then(setHistory).catch(() => setHistory([]));
    }
  }, [tab, aiOn]);

  // ---- derived -------------------------------------------------------------

  const proposalTemplates = useMemo(() => templates.filter((t) => t.kind === "proposal"), [templates]);
  const contractTemplates = useMemo(() => templates.filter((t) => t.kind === "contract"), [templates]);
  // "Client Proposals" now covers every proposal-shaped sales document (proposal, quote, invoice, payment request); contracts stay separate.
  const proposalDocs = useMemo(() => documents.filter((d) => d.kind !== "contract"), [documents]);
  const contractDocs = useMemo(() => documents.filter((d) => d.kind === "contract"), [documents]);

  const clientName = useCallback(
    (id: string | null) => {const client=clients.find(c=>c.id===id);return client?.companyName||client?.contactName||"Unassigned client";},
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
    if(kind==='proposal'){setGuided({});return;}
    setCreateKind(kind);
    setCDocType(kind === "contract" ? "contract" : "proposal");
    const first = contractTemplates[0];
    setCTemplateId(first?.id ?? "");
    setCClientId(clients[0]?.id ?? "");
    setCTitle("");
    setCMode(clients.length ? "client" : "prospect");
    setCProspect(emptyProspect());
    setCLineItems([]);
    setCCampaignId("");
  }

  function openDocumentBuilder(d: ClientDocument) {
    if(d.kind==='proposal'){setGuided({existing:d as DocRow});return;}
    setView({
      mode: "builder",
      ctx: {
        scope: "document", kind: d.kind === "contract" ? "contract" : "proposal", id: d.id, title: d.title,
        style: d.style, sections: d.sections,
        subtitle: d.clientId ? `For ${clientName(d.clientId)}` : (d as DocRow).prospect ? `For ${recipientOf(d as DocRow, clientName)} (prospect)` : undefined,
      },
    });
  }

  async function submitCreate() {
    if (!createKind) return;
    setCreating(true);
    setError(null);
    try {
      const prospect = cMode === "prospect" ? cProspect : null;
      if (prospect && (!prospect.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(prospect.email.trim()))) { setError("Enter the prospect's name and a valid email."); setCreating(false); return; }
      const { id } = await createClientDocument({
        kind: createKind === "contract" ? "contract" : cDocType,
        clientId: prospect ? null : cClientId || null,
        templateId: cTemplateId || null,
        title: cTitle.trim() || undefined,
        ...(prospect ? { prospect } : {}),
        lineItems: cLineItems.filter((li) => li.productId),
        campaignId: cCampaignId || null,
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
      sessionLinks.current.delete(d.id);
      await refreshLists();
    } catch (e) {
      setError(msgOf(e, "Could not update the status."));
    }
  }

  // ---- FLOW 4: send / copy link ---------------------------------------------
  const defaultRecipient = (d: DocRow) => d.sentTo || clients.find((c) => c.id === d.clientId)?.email || d.prospect?.email || "";
  async function onNewLink(d: DocRow) {
    if (linkRequest.current) return;
    const cached = sessionLinks.current.get(d.id);
    if (cached && (!cached.expiresAt || new Date(cached.expiresAt).getTime() > Date.now())) { setShareResult(cached); setLinkError(''); setLinkOpen(true); return; }
    if (d.hasLink && !window.confirm("Generate a replacement approval link? The previously shared link will stop working. Cancel to keep it unchanged.")) return;
    linkRequest.current = true;
    setError(null); setShareResult(null); setLinkError(''); setLinkOpen(true); setLinkBusy(true);
    try {
      const result = await mintDocumentLink(d.id);
      sessionLinks.current.set(d.id, result);
      setShareResult(result);
      await refreshLists();
    } catch (e) { setLinkError(msgOf(e, "Could not generate the link. Please try again.")); }
    finally { linkRequest.current = false; setLinkBusy(false); }
  }
  async function onShared(r: ShareResult) {
    if (shareDoc) sessionLinks.current.set(shareDoc.id, r);
    setShareDoc(null); setShareResult(r); setLinkError(''); setLinkOpen(true); await refreshLists();
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
    { id: "proposalDocs", label: "Proposals", icon: <FileText className="h-4 w-4" />, show: proposalsOn },
    { id: "contractDocs", label: "Client Contracts", icon: <FileSignature className="h-4 w-4" />, show: contractsOn },
    { id: "ai", label: "AI History", icon: <History className="h-4 w-4" />, show: aiOn },
  ];
  const tabs = allTabs.sort((a,b)=>(a.id==='proposalDocs'?-1:b.id==='proposalDocs'?1:0)).filter((t) => t.show);

  const activeTab: Tab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" onClick={() => setView({ mode: "wizard" })}>
        <Sparkles className="h-4 w-4" /> {profile ? "Edit business profile" : "Set up business"}
      </Button>
    </div>
  );

  if(guided) return <ProposalBuilder key={guided.existing?.id||'new'} existing={guided.existing} clients={clients} salespeople={data.salespeople} salespersonId={user?.salespersonId} self={isSelf} products={catalog} campaigns={campaignOptions} currency={currency} digits={digits} loading={catalogLoading} loadError={catalogError} branding={brandingFromProfile(profile,companyName)} aiReady={aiOn&&ai.configured} businessName={profile?.businessName} defaultTerms={profile?.paymentTerms} onClose={()=>setGuided(null)} onSaved={async()=>{await refreshLists();setGuided(null);setTab('proposalDocs');setSavedNotice('Proposal saved as a draft. Preview it, then share a client approval link.');}}/>;

  return (
    <div className="space-y-6 proposal-center">
      <PageHeader
        title="Proposals & contracts"
        subtitle="Choose your products, prepare a proposal, and track it from first view to payment."
        actions={headerActions}
      />

      {error && (
        <Card className="border-rose-200 bg-rose-50 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </Card>
      )}
      {savedNotice&&<p role="status" className="proposal-success">{savedNotice}</p>}
      {activeTab==='proposalDocs'&&<div className="proposal-metrics">{[{label:'Drafts',value:proposalDocs.filter(d=>d.status==='draft').length},{label:'Awaiting client',value:proposalDocs.filter(d=>d.status==='sent'||d.status==='viewed').length},{label:'Approved',value:proposalDocs.filter(d=>d.status==='signed').length},{label:'Paid invoices',value:proposalDocs.filter(d=>d.ghlInvoiceStatus==='paid').length}].map(m=><div key={m.label}><span>{m.label}</span><strong>{m.value}</strong></div>)}</div>}
      <Modal open={linkOpen} title={linkBusy ? 'Creating your proposal link' : 'Share proposal'} onClose={() => { if (!linkBusy) setLinkOpen(false); }} size="lg">
        {linkBusy && !shareResult && <p role="status" className="flex items-center gap-2 py-6"><Loader2 className="h-5 w-5 animate-spin"/>Creating your private approval link…</p>}
        {linkError && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-700">{linkError}</p>}
        {shareResult && <LinkBanner key={shareResult.link} result={shareResult} onClose={() => setLinkOpen(false)} />}
      </Modal>

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
              salespeople={data.salespeople}
              currency={currency}
              clientName={clientName}
              onNew={() => openCreateModal("proposal")}
              onEdit={openDocumentBuilder}
              onPreview={(d) => openPreview("document", d.id, d.clientId)}
              onStatus={changeStatus}
              onSend={(d) => setShareDoc(d)}
              onLink={onNewLink}
              onPricing={(d) => setPricingDoc(d)}
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
              onSend={(d) => setShareDoc(d)}
              onLink={onNewLink}
              onPricing={(d) => setPricingDoc(d)}
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
        title={`New ${createKind === "contract" ? "contract" : DOC_TYPE_LABELS[cDocType].toLowerCase()}`}
        size="lg"
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
          {createKind !== "contract" && (
            <Field label="Document type" hint="Proposals and quotes present pricing; invoices and payment requests collect payment in GoHighLevel.">
              <Select value={cDocType} onChange={(e) => setCDocType(e.target.value as ClientDocKind)}>
                {SALES_DOC_TYPES.map((k) => <option key={k} value={k}>{DOC_TYPE_LABELS[k]}</option>)}
              </Select>
            </Field>
          )}
          <div className="st-mode-toggle" role="radiogroup" aria-label="Who is this for">
            <button type="button" role="radio" aria-checked={cMode === "client"} className={cMode === "client" ? "is-active" : ""} onClick={() => setCMode("client")}><Building2 className="h-4 w-4" /> Existing client</button>
            <button type="button" role="radio" aria-checked={cMode === "prospect"} className={cMode === "prospect" ? "is-active" : ""} onClick={() => setCMode("prospect")}><UserPlus className="h-4 w-4" /> New prospect</button>
          </div>
          {cMode === "client" ? (
            <Field label="Client" hint="Self-serve roles only see their own clients.">
              <Select value={cClientId} onChange={(e) => setCClientId(e.target.value)}>
                <option value="">— No client (generic) —</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.companyName}</option>
                ))}
              </Select>
            </Field>
          ) : (
            <div className="space-y-1">
              <ProspectFields value={cProspect} onChange={setCProspect} />
              <p className="text-xs text-slate-500">The client record is created automatically when the prospect approves.</p>
            </div>
          )}
          <Field label="Start from template" hint="The template's sections are copied in; client details are merged automatically.">
            <Select value={cTemplateId} onChange={(e) => setCTemplateId(e.target.value)}>
              <option value="">— Blank starter —</option>
              {(createKind === "contract" ? contractTemplates : proposalTemplates).map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (default)" : ""}</option>
              ))}
            </Select>
          </Field>
          <Field label="Title" hint="Leave blank to auto-name from the client.">
            <Input value={cTitle} onChange={(e) => setCTitle(e.target.value)} placeholder={`${createKind === "contract" ? "Service Agreement" : DOC_TYPE_LABELS[cDocType]}…`} />
          </Field>
          <Field label="Campaign" hint="Link this document to a campaign so a paid sale flows commission to the right plan.">
            <Select value={cCampaignId} onChange={(e) => setCCampaignId(e.target.value)}>
              <option value="">— No campaign —</option>
              {campaignOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <LineItemsEditor items={cLineItems} onChange={setCLineItems} products={catalog} currency={currency} digits={digits} loading={catalogLoading} />
        </div>
      </Modal>

      {/* FLOW 4: send-for-approval dialog */}
      <ShareDialog key={shareDoc?.id ?? "none"} doc={shareDoc} defaultTo={shareDoc ? defaultRecipient(shareDoc) : ""} onClose={() => setShareDoc(null)} onSent={onShared} />

      {/* Wave 3: edit products, pricing & campaign link on an existing document */}
      <PricingDialog
        key={pricingDoc?.id ?? "none-pricing"}
        doc={pricingDoc}
        products={catalog}
        campaigns={campaignOptions}
        currency={currency}
        digits={digits}
        catalogLoading={catalogLoading}
        onClose={() => setPricingDoc(null)}
        onSaved={async (lineItems, campaignId) => {
          await updateClientDocument(pricingDoc!.id, { lineItems: lineItems.filter((li) => li.productId), campaignId: campaignId || null });
          await refreshLists();
          setPricingDoc(null);
        }}
      />

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
            {previewData.kind==='contract'?<DocumentPreview
              kind={previewData.kind}
              title={previewData.title}
              style={previewData.style}
              sections={previewData.sections}
              branding={previewData.branding ?? brandingFromProfile(profile, companyName)}
            />:<ProposalSheet title={previewData.title} sections={previewData.sections} branding={previewData.branding ?? brandingFromProfile(profile, companyName)} items={previewData.lineItems} currency={previewData.currency||currency} digits={previewData.digits??digits}/>}

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
  kind, docs, clientName, salespeople=[], currency="USD", onNew, onEdit, onPreview, onStatus, onSend, onLink, onPricing,
}: {
  kind: DocumentKind;
  docs: ClientDocument[];
  salespeople?: {id:string;name:string}[];
  currency?: string;
  clientName: (id: string | null) => string;
  onNew: () => void;
  onEdit: (d: ClientDocument) => void;
  onPreview: (d: ClientDocument) => void;
  onStatus: (d: ClientDocument, status: DocStatus) => void;
  onSend: (d: DocRow) => void;
  onLink: (d: DocRow) => void;
  onPricing: (d: DocRow) => void;
}) {
  const label = kind === "contract" ? "contract" : "proposal";
  const [search,setSearch]=useState('');
  const [statusFilter,setStatusFilter]=useState('');
  const visible=docs.filter(d=>(!statusFilter||d.status===statusFilter)&&`${d.title} ${recipientOf(d as DocRow,clientName)} ${salespeople.find(s=>s.id===d.salespersonId)?.name||''}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="space-y-4">
      {kind === "contract" && <ContractNotice />}
      <div className="flex items-center justify-between">
        <SectionTitle>{kind === "contract" ? "Client contracts" : "Client proposals"}</SectionTitle>
        <Button onClick={onNew}><Plus className="h-4 w-4" /> Create for client</Button>
      </div>

      <div className="proposal-fields-two"><Input aria-label="Search proposals" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search proposal, client or salesman…"/><Select aria-label="Proposal status" value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="">All statuses</option><option value="draft">Draft</option><option value="sent">Shared</option><option value="viewed">Viewed</option><option value="signed">Approved</option><option value="canceled">Canceled</option></Select></div>
      {visible.length === 0 ? (
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
                {kind !== "contract" && <TH>Type</TH>}
                <TH>Client</TH>
                <TH>First payment</TH>
                <TH>Salesman</TH>
                <TH>Status</TH>
                <TH>Updated</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {visible.map((raw) => {
                const d = raw as DocRow;
                const next = kind==='contract'?NEXT_STATUS[d.status]:null;
                const shareable = !isTerminalStatus(d.status);
                return (
                  <TR key={d.id}>
                    <TD>
                      <div className="font-medium text-slate-800 dark:text-slate-100">{d.title}</div>
                      {d.sentTo && d.status !== "signed" && <div className="text-xs text-slate-500">Sent to {d.sentTo}{d.viewedAt ? ` · viewed ${formatDate(d.viewedAt)}` : ""}</div>}
                      <div className="proposal-activity"><span>{d.sentAt?`Shared ${formatDate(d.sentAt)}`:'Not shared yet'}</span>{d.viewedAt&&<span>Viewed {formatDate(d.viewedAt)}</span>}{d.signedAt&&<span>Approved {formatDate(d.signedAt)}</span>}</div>
                      <ApprovalCard doc={d} />
                      <InvoiceState doc={d} />
                    </TD>
                    {kind !== "contract" && <TD><Badge tone="slate">{DOC_TYPE_LABELS[d.kind] ?? d.kind}</Badge></TD>}
                    <TD>{recipientOf(d, clientName)}{!d.clientId && d.prospect && <> <Badge tone="violet">Prospect</Badge></>}</TD>
                    <TD>{d.amount.toLocaleString("en-US",{style:"currency",currency})}</TD>
                    <TD>{salespeople.find(s=>s.id===d.salespersonId)?.name||"Unassigned"}</TD>
                    <TD><DocStatusBadge status={d.status} /></TD>
                    <TD className="text-slate-500">{formatDate(d.updatedAt)}</TD>
                    <TD>
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => onPreview(d)} aria-label="Preview"><Eye className="h-4 w-4" /></Button>
                        {d.status === "draft" && !d.ghlInvoiceId && (
                          <Button variant="ghost" size="sm" onClick={() => onEdit(d)} aria-label="Edit sections"><Pencil className="h-4 w-4" /></Button>
                        )}
                        {d.status === "draft" && !d.ghlInvoiceId && (
                          <Button variant="ghost" size="sm" onClick={() => d.kind==='proposal'?onEdit(d):onPricing(d)} aria-label="Products & pricing" title="Products, pricing & campaign"><Boxes className="h-4 w-4" /> Pricing</Button>
                        )}
                        {shareable && (
                          <Button variant="subtle" size="sm" onClick={() => onSend(d)} aria-label="Send for approval">
                            <Send className="h-4 w-4" /> Send
                          </Button>
                        )}
                        {shareable && (
                          <Button variant="ghost" size="sm" onClick={() => onLink(d)} aria-label={d.hasLink ? "Get link" : "Create link"} title="Show a shareable proposal link">
                            <Link2 className="h-4 w-4" /> {d.hasLink ? "Get link" : "Create link"}
                          </Button>
                        )}
                        {next && (
                          <Button variant="ghost" size="sm" onClick={() => onStatus(d, next)}>
                            <CheckCircle2 className="h-4 w-4" />
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

// ----------------------------------------------------------------------------
// GHL invoice state — shown once an invoice exists for the document. Payment is
// always collected inside GoHighLevel; we surface the pay link + paid status.
// ----------------------------------------------------------------------------

function InvoiceState({ doc }: { doc: DocRow }) {
  if (!doc.ghlInvoiceUrl) return null;
  const paid = (doc.ghlInvoiceStatus ?? "").toLowerCase() === "paid";
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs dark:border-slate-800 dark:bg-slate-800/40">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={paid ? "green" : "amber"}>{paid ? "Paid" : (doc.ghlInvoiceStatus || "Awaiting payment")}</Badge>
        <span className="text-slate-500">Invoice sent — payment is collected in GoHighLevel.</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <a href={doc.ghlInvoiceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-300">
          <ExternalLink className="h-3.5 w-3.5" /> Open pay link
        </a>
        <Button variant="ghost" size="sm" type="button" onClick={() => { navigator.clipboard?.writeText(doc.ghlInvoiceUrl!).catch(() => {}); }}>
          <Copy className="h-3.5 w-3.5" /> Copy
        </Button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// PricingDialog — edit products, pricing & the campaign link on a document.
// ----------------------------------------------------------------------------

function PricingDialog({
  doc, products, campaigns, currency, digits, catalogLoading, onClose, onSaved,
}: {
  doc: DocRow | null;
  products: CatalogProduct[];
  campaigns: { id: string; name: string }[];
  currency: string;
  digits: number;
  catalogLoading: boolean;
  onClose: () => void;
  onSaved: (lineItems: DocumentLineItem[], campaignId: string) => Promise<void>;
}) {
  const [items, setItems] = useState<DocumentLineItem[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!doc) return;
    setItems((doc.lineItems ?? []).map((li) => ({ ...li })));
    setCampaignId(doc.campaignId ?? "");
    setError("");
  }, [doc]);

  if (!doc) return null;
  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose(); }}
      title="Products, pricing & campaign"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true); setError("");
              try { await onSaved(items, campaignId); }
              catch (e) { setError(msgOf(e, "Could not save pricing.")); }
              finally { setBusy(false); }
            }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Save
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && <Card className="border-rose-200 bg-rose-50 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">{error}</Card>}
        <Field label="Campaign" hint="Links a paid sale to the campaign that pays commission.">
          <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">— No campaign —</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <LineItemsEditor items={items} onChange={setItems} products={products} currency={currency} digits={digits} loading={catalogLoading} />
        <p className="text-xs text-slate-500">Prices at or above each product's floor are accepted; a lower price is blocked. The document total updates from these line items.</p>
      </div>
    </Modal>
  );
}
