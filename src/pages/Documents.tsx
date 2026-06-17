// ============================================================================
// DOCUMENTS — Proposals & Contracts
//
// Foundation UI for proposals and contracts. Data comes from /api/documents,
// which is tenant-scoped on the server (self roles only ever see their own
// clients' documents). Clients come from AppContext, which is also already
// role-scoped, so the client picker can never leak another tenant's records.
//
// Lifecycle: Draft -> Sent -> Viewed -> Signed (or Canceled at any point).
// E-signature is intentionally NOT wired up yet — this is the structure only.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { FileSignature, FileText, Plus, Eye, Loader2, Send, CheckCircle2, XCircle } from "lucide-react";
import { useApp } from "../store/AppContext";
import {
  PageHeader,
  Card,
  Button,
  Badge,
  SectionTitle,
  EmptyState,
  Field,
  Input,
  Textarea,
  Select,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "../components/ui";
import { Modal } from "../components/ui/Modal";
import { formatCurrency, formatDate } from "../lib/format";

type Kind = "proposal" | "contract";
type DocStatus = "draft" | "sent" | "viewed" | "signed" | "canceled";

interface Template {
  id: string;
  tenant_id: string;
  kind: Kind;
  name: string;
  body: string;
  is_default: boolean;
}

interface Doc {
  id: string;
  tenant_id: string;
  kind: Kind;
  title: string;
  client_id: string | null;
  salesperson_id: string | null;
  template_id: string | null;
  body: string;
  status: DocStatus;
  amount: number | string | null;
  created_at: string;
}

const STATUS_TONE: Record<DocStatus, "slate" | "blue" | "indigo" | "green" | "rose"> = {
  draft: "slate",
  sent: "blue",
  viewed: "indigo",
  signed: "green",
  canceled: "rose",
};
const STATUS_LABEL: Record<DocStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  signed: "Signed",
  canceled: "Canceled",
};
/** The status a document can advance to next (besides Cancel). */
const NEXT_STATUS: Partial<Record<DocStatus, DocStatus>> = {
  draft: "sent",
  sent: "viewed",
  viewed: "signed",
};

const ADMIN_ROLES = ["owner", "admin", "sales_manager"];

type Tab = "proposals" | "contracts" | "templates";

export default function Documents() {
  const { data, role } = useApp();
  const canManageTemplates = ADMIN_ROLES.includes(role);

  const [tab, setTab] = useState<Tab>("proposals");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // create document modal
  const [createKind, setCreateKind] = useState<Kind | null>(null);
  const [clientId, setClientId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  // template modal
  const [tplOpen, setTplOpen] = useState(false);
  const [tplKind, setTplKind] = useState<Kind>("proposal");
  const [tplName, setTplName] = useState("");
  const [tplBody, setTplBody] = useState("");

  // preview
  const [preview, setPreview] = useState<Doc | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/documents");
      if (!res.ok) throw new Error(`error_${res.status}`);
      const body = await res.json();
      setTemplates(body.templates ?? []);
      setDocs(body.documents ?? []);
    } catch {
      setTemplates([]);
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [role]);

  const proposals = useMemo(() => docs.filter((d) => d.kind === "proposal"), [docs]);
  const contracts = useMemo(() => docs.filter((d) => d.kind === "contract"), [docs]);
  const templatesForKind = (k: Kind) => templates.filter((t) => t.kind === k);
  const clientName = (id: string | null) =>
    data.clients.find((c) => c.id === id)?.companyName ?? "—";

  function openCreate(kind: Kind) {
    setCreateKind(kind);
    setClientId(data.clients[0]?.id ?? "");
    setTemplateId(templatesForKind(kind)[0]?.id ?? "");
    setTitle("");
    setError(null);
  }

  async function submitCreate() {
    if (!createKind) return;
    if (!clientId) {
      setError("Pick a client first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "create", kind: createKind, clientId, templateId: templateId || undefined, title: title || undefined }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `error_${res.status}`);
      }
      setCreateKind(null);
      await load();
    } catch (e: any) {
      setError(e?.message === "client_not_yours" ? "You can only create documents for your own clients." : "Couldn't create the document. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitTemplate() {
    if (!tplName.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "create_template", kind: tplKind, name: tplName, body: tplBody }),
      });
      if (res.ok) {
        setTplOpen(false);
        setTplName("");
        setTplBody("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: DocStatus) {
    setBusy(true);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "set_status", id, status }),
      });
      if (res.ok) {
        setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, status } : d)));
        setPreview((p) => (p && p.id === id ? { ...p, status } : p));
      }
    } finally {
      setBusy(false);
    }
  }

  const docList = tab === "proposals" ? proposals : tab === "contracts" ? contracts : [];

  function renderDocTable(kind: Kind, list: Doc[]) {
    if (list.length === 0) {
      return (
        <div className="p-6">
          <EmptyState
            icon={kind === "contract" ? <FileSignature className="h-6 w-6" /> : <FileText className="h-6 w-6" />}
            title={`No ${kind}s yet`}
            description={`Create your first ${kind} from a client and template.`}
            action={<Button onClick={() => openCreate(kind)}><Plus className="h-4 w-4" /> New {kind}</Button>}
          />
        </div>
      );
    }
    return (
      <Table>
        <THead>
          <TR>
            <TH>Title</TH>
            <TH>Client</TH>
            <TH>Created</TH>
            <TH className="text-right">Amount</TH>
            <TH>Status</TH>
            <TH className="text-right">Actions</TH>
          </TR>
        </THead>
        <TBody>
          {list.map((d) => {
            const next = NEXT_STATUS[d.status];
            const terminal = d.status === "signed" || d.status === "canceled";
            return (
              <TR key={d.id}>
                <TD className="font-medium text-slate-900 dark:text-white">{d.title}</TD>
                <TD>{clientName(d.client_id)}</TD>
                <TD className="text-slate-500">{formatDate(d.created_at)}</TD>
                <TD className="text-right tabular-nums">{formatCurrency(Number(d.amount ?? 0))}</TD>
                <TD><Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge></TD>
                <TD className="text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => setPreview(d)}>
                      <Eye className="h-4 w-4" /> Preview
                    </Button>
                    {next && (
                      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void setStatus(d.id, next)}>
                        <Send className="h-4 w-4" /> Mark {STATUS_LABEL[next]}
                      </Button>
                    )}
                    {!terminal && (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void setStatus(d.id, "canceled")}>
                        <XCircle className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    );
  }

  return (
    <div>
      <PageHeader
        title="Proposals & Contracts"
        subtitle="Create proposals and contracts for your clients from reusable templates."
        actions={
          tab === "templates" ? (
            canManageTemplates && (
              <Button onClick={() => setTplOpen(true)}><Plus className="h-4 w-4" /> New template</Button>
            )
          ) : (
            <Button onClick={() => openCreate(tab === "contracts" ? "contract" : "proposal")}>
              <Plus className="h-4 w-4" /> New {tab === "contracts" ? "contract" : "proposal"}
            </Button>
          )
        }
      />

      {/* Tabs */}
      <div className="mb-5 flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800/60 sm:inline-flex">
        {([
          ["proposals", "Proposals", proposals.length],
          ["contracts", "Contracts", contracts.length],
          ["templates", "Templates", templates.length],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={
              "flex-1 whitespace-nowrap rounded-md px-4 py-1.5 text-sm font-medium transition sm:flex-none " +
              (tab === key
                ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white"
                : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200")
            }
          >
            {label} <span className="ml-1 text-xs opacity-60">{count}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <Card className="flex items-center justify-center py-16 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </Card>
      ) : tab === "templates" ? (
        <div className="space-y-6">
          {(["proposal", "contract"] as Kind[]).map((k) => (
            <div key={k}>
              <SectionTitle>{k === "proposal" ? "Proposal templates" : "Contract templates"}</SectionTitle>
              {templatesForKind(k).length === 0 ? (
                <Card><p className="text-sm text-slate-400">No {k} templates yet.</p></Card>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {templatesForKind(k).map((t) => (
                    <Card key={t.id} className="flex flex-col">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <h4 className="font-semibold text-slate-900 dark:text-white">{t.name}</h4>
                        {t.is_default && <Badge tone="violet">Default</Badge>}
                      </div>
                      <p className="line-clamp-4 whitespace-pre-wrap text-xs text-slate-500">{t.body}</p>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Card padded={false} className="overflow-hidden">
          {renderDocTable(tab === "contracts" ? "contract" : "proposal", docList)}
        </Card>
      )}

      {/* Create document modal */}
      <Modal
        open={createKind !== null}
        onClose={() => setCreateKind(null)}
        title={`New ${createKind ?? "document"}`}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateKind(null)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void submitCreate()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Client" required>
            <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {data.clients.length === 0 && <option value="">No clients available</option>}
              {data.clients.map((c) => (
                <option key={c.id} value={c.id}>{c.companyName}</option>
              ))}
            </Select>
          </Field>
          <Field label="Template">
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Blank (no template)</option>
              {createKind && templatesForKind(createKind).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Title" hint="Leave blank to auto-name from the client.">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Q3 Growth Proposal" />
          </Field>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <p className="text-xs text-slate-400">
            Template tokens like company, contact, setup fee and monthly are filled in automatically from the client.
          </p>
        </div>
      </Modal>

      {/* Create template modal */}
      <Modal
        open={tplOpen}
        onClose={() => setTplOpen(false)}
        title="New template"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setTplOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={() => void submitTemplate()} disabled={busy || !tplName.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Save template
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Type">
            <Select value={tplKind} onChange={(e) => setTplKind(e.target.value as Kind)}>
              <option value="proposal">Proposal</option>
              <option value="contract">Contract</option>
            </Select>
          </Field>
          <Field label="Name" required>
            <Input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="e.g. Premium Service Proposal" />
          </Field>
          <Field label="Body" hint="Use tokens {{company}}, {{contact}}, {{setup_fee}}, {{monthly}}.">
            <Textarea rows={10} value={tplBody} onChange={(e) => setTplBody(e.target.value)} />
          </Field>
        </div>
      </Modal>

      {/* Preview modal */}
      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview?.title ?? "Preview"}
        size="xl"
        footer={
          preview && (
            <div className="flex w-full items-center justify-between gap-2">
              <Badge tone={STATUS_TONE[preview.status]}>{STATUS_LABEL[preview.status]}</Badge>
              <div className="flex gap-2">
                {NEXT_STATUS[preview.status] && (
                  <Button variant="secondary" disabled={busy} onClick={() => void setStatus(preview.id, NEXT_STATUS[preview.status]!)}>
                    <Send className="h-4 w-4" /> Mark {STATUS_LABEL[NEXT_STATUS[preview.status]!]}
                  </Button>
                )}
                {preview.status === "viewed" && (
                  <Button disabled={busy} onClick={() => void setStatus(preview.id, "signed")}>
                    <CheckCircle2 className="h-4 w-4" /> Mark signed
                  </Button>
                )}
              </div>
            </div>
          )
        }
      >
        {preview && (
          <div>
            <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-500">
              <span>Client: <span className="text-slate-700 dark:text-slate-200">{clientName(preview.client_id)}</span></span>
              <span>Amount: <span className="text-slate-700 dark:text-slate-200">{formatCurrency(Number(preview.amount ?? 0))}</span></span>
              <span>Created: <span className="text-slate-700 dark:text-slate-200">{formatDate(preview.created_at)}</span></span>
            </div>
            <div className="max-h-[55vh] overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-5 font-mono text-sm leading-relaxed whitespace-pre-wrap text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-200">
              {preview.body || "(This document has no body. It was created from a blank template.)"}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
