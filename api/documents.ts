// /api/documents — proposal/contract TEMPLATES + per-client DOCUMENTS, built
// from structured, reorderable SECTIONS (not one text blob).
//
//   GET  ?kind&clientId&status        -> { templates, documents } (tenant-scoped)
//   POST { op:'create_template', kind, name, description?, style?, sections? }
//   POST { op:'update_template', id, name?, description?, style?, sections? }
//   POST { op:'duplicate_template', id }
//   POST { op:'delete_template', id }
//   POST { op:'section_add', scope, id, kind, sectionType, atIndex? }
//   POST { op:'section_update', scope, id, sectionId, title?, content?, type? }
//   POST { op:'section_delete', scope, id, sectionId }
//   POST { op:'section_reorder', scope, id, orderedIds }
//   POST { op:'create', kind, clientId?, templateId?, title? }   (bakes merge fields)
//   POST { op:'update_document', id, title?, style?, sections? }
//   POST { op:'set_status', id, status }     draft|sent|viewed|signed|canceled
//   POST { op:'preview', scope, id, clientId? } -> merge-resolved sections + branding
//
// SECURITY: tenant ALWAYS from the session, never the client; every read/write
// is tenant_id-filtered so a document cannot cross sub-accounts. Templates are
// managed by owner/admin/manager; self roles (salesperson/affiliate/partner)
// only see + act on their own clients' documents. Proposal writes require the
// `proposals` feature; contract writes require `contracts`. These rows are
// server-owned and untouched by the /api/state snapshot save.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser } from "./_lib/auth.js";
import { readTenantFlags } from "./_lib/feature-access.js";
import {
  rowToTemplate,
  rowToDocument,
  rowToBusinessProfile,
  canManageTemplates,
  canCreateClientDoc,
  isSelfRole,
  addSection,
  updateSection,
  deleteSection,
  reorderSections,
  normalizeSections,
} from "./_lib/documents-core.js";
import {
  defaultSections,
  coerceStyle,
  isValidStatus,
  canTransitionStatus,
  buildMergeContext,
  applySectionsMerge,
  type MergeContext,
} from "../src/lib/documents.js";
import type { DocumentKind, DocumentSection, DocStatus, BusinessProfile } from "../src/types/index.js";

const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const asKind = (v: unknown): DocumentKind => (v === "contract" ? "contract" : "proposal");

/** Plain-text render of sections, kept in the legacy `body` column for back-compat. */
function sectionsToBody(sections: DocumentSection[]): string {
  return sections
    .map((s) => `${(s.title || "").toUpperCase()}\n${s.content || ""}`.trim())
    .join("\n\n");
}

// Starter templates seeded once per tenant so the builder is never empty.
const DEFAULT_TEMPLATES: Array<{ kind: DocumentKind; name: string; description: string }> = [
  { kind: "proposal", name: "Standard Service Proposal", description: "A clean, sectioned proposal starter." },
  { kind: "contract", name: "Standard Service Agreement", description: "A sectioned service contract starter." },
];

async function ensureDefaultTemplates(tenantId: string, userId: string): Promise<void> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM document_templates WHERE tenant_id = $1`,
    [tenantId],
  );
  if (Number(rows[0]?.n ?? 0) > 0) return;
  for (const t of DEFAULT_TEMPLATES) {
    const sections = defaultSections(t.kind);
    await query(
      `INSERT INTO document_templates
         (id, tenant_id, kind, name, description, body, sections, style, is_default, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'modern',true,$8)`,
      [uid("tpl"), tenantId, t.kind, t.name, t.description, sectionsToBody(sections), JSON.stringify(sections), userId],
    );
  }
}

/** Load + tenant-scope a template; returns null if not in this tenant. */
async function loadTemplateRow(tenantId: string, id: string): Promise<any | null> {
  const { rows } = await query<any>(
    `SELECT * FROM document_templates WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

/** Load a document, scoped to tenant + role (self roles only their own). */
async function loadDocumentRow(user: any, id: string): Promise<any | null> {
  let sql = `SELECT * FROM documents WHERE tenant_id = $1 AND id = $2`;
  const params: any[] = [user.tenantId, id];
  if (user.role === "sales_manager") {
    sql += ` AND salesperson_id IN (SELECT id FROM salespeople WHERE tenant_id = $1 AND manager_user_id = $3)`;
    params.push(user.id);
  } else if (isSelfRole(user.role)) {
    sql += ` AND salesperson_id = $3`;
    params.push(user.salespersonId ?? "__none__");
  }
  const { rows } = await query<any>(sql, params);
  return rows[0] ?? null;
}

async function loadBusinessProfile(tenantId: string): Promise<BusinessProfile | null> {
  const { rows } = await query<any>(`SELECT * FROM business_profiles WHERE tenant_id = $1`, [tenantId]);
  return rows[0] ? rowToBusinessProfile(rows[0]) : null;
}

/** Resolve a client row (tenant-scoped; self roles must own it). */
async function resolveClient(
  user: any,
  clientId: string | null,
): Promise<{ ok: true; client: any | null } | { ok: false; status: number; error: string }> {
  if (!clientId) return { ok: true, client: null };
  const { rows } = await query<any>(`SELECT * FROM clients WHERE tenant_id = $1 AND id = $2`, [user.tenantId, clientId]);
  const client = rows[0] ?? null;
  if (!client) return { ok: false, status: 400, error: "invalid_client" };
  if (isSelfRole(user.role) && client.salesperson_id !== user.salespersonId) {
    return { ok: false, status: 403, error: "client_not_yours" };
  }
  return { ok: true, client };
}

async function salespersonName(tenantId: string, salespersonId: string | null, fallback: string): Promise<string> {
  if (!salespersonId) return fallback;
  const { rows } = await query<{ name: string }>(
    `SELECT name FROM salespeople WHERE tenant_id = $1 AND id = $2`,
    [tenantId, salespersonId],
  );
  return rows[0]?.name || fallback;
}

function mergeContextFor(business: BusinessProfile | null, client: any | null, spName: string): MergeContext {
  return buildMergeContext({
    business,
    client: client
      ? {
          companyName: client.company_name,
          contactName: client.contact_name,
          email: client.email,
          phone: client.phone,
          setupFee: client.setup_fee_amount,
          monthlySubscription: client.monthly_subscription_amount,
          signupDate: client.signup_date,
        }
      : null,
    salespersonName: spName,
  });
}

/** Compact branding payload for the client-facing preview. */
function brandingOf(b: BusinessProfile | null) {
  if (!b) return null;
  return {
    businessName: b.businessName,
    logoUrl: b.logoUrl,
    website: b.website,
    companyAddress: b.companyAddress,
    contactEmail: b.contactEmail,
    contactPhone: b.contactPhone,
    brandTone: b.brandTone,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    await ensureDefaultTemplates(user.tenantId, user.id);

    const flags = await readTenantFlags(user.tenantId);
    const kindEnabled = (kind: DocumentKind) => (kind === "contract" ? flags.contracts !== false : flags.proposals !== false);
    // Guard a write for a given kind behind its feature flag.
    const ensureKind = (kind: DocumentKind): string | null =>
      kindEnabled(kind) ? null : kind === "contract" ? "contracts_disabled" : "proposals_disabled";

    // ----------------------------------------------------------------- GET
    if (req.method === "GET") {
      const filterKind = req.query.kind ? asKind(req.query.kind) : null;
      const filterClient = req.query.clientId ? String(req.query.clientId) : null;
      const filterStatus = req.query.status ? String(req.query.status) : null;

      const tparams: any[] = [user.tenantId];
      let tsql = `SELECT * FROM document_templates WHERE tenant_id = $1`;
      if (filterKind) {
        tsql += ` AND kind = $2`;
        tparams.push(filterKind);
      }
      tsql += ` ORDER BY kind, name`;
      const templatesRes = await query<any>(tsql, tparams);

      let docsSql = `SELECT * FROM documents WHERE tenant_id = $1`;
      const params: any[] = [user.tenantId];
      if (user.role === "sales_manager") {
        docsSql += ` AND salesperson_id IN (SELECT id FROM salespeople WHERE tenant_id = $1 AND manager_user_id = $${params.length + 1})`;
        params.push(user.id);
      } else if (isSelfRole(user.role)) {
        docsSql += ` AND salesperson_id = $${params.length + 1}`;
        params.push(user.salespersonId ?? "__none__");
      }
      if (filterKind) {
        docsSql += ` AND kind = $${params.length + 1}`;
        params.push(filterKind);
      }
      if (filterClient) {
        docsSql += ` AND client_id = $${params.length + 1}`;
        params.push(filterClient);
      }
      if (filterStatus && isValidStatus(filterStatus)) {
        docsSql += ` AND status = $${params.length + 1}`;
        params.push(filterStatus);
      }
      docsSql += ` ORDER BY created_at DESC`;
      const docsRes = await query<any>(docsSql, params);

      return res.status(200).json({
        templates: templatesRes.rows.map(rowToTemplate),
        documents: docsRes.rows.map(rowToDocument),
        features: { proposals: flags.proposals !== false, contracts: flags.contracts !== false, ai: flags.ai !== false },
      });
    }

    // ----------------------------------------------------------------- POST
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
      const op = String(body.op ?? "");

      // ---- template: create ----
      if (op === "create_template") {
        if (!canManageTemplates(user.role)) return res.status(403).json({ error: "forbidden" });
        const kind = asKind(body.kind);
        const gate = ensureKind(kind);
        if (gate) return res.status(403).json({ error: gate });
        const name = String(body.name ?? "").trim() || `Untitled ${kind}`;
        const description = String(body.description ?? "").trim();
        const style = coerceStyle(body.style);
        const sections =
          body.sections != null ? normalizeSections(kind, body.sections) : defaultSections(kind);
        const id = uid("tpl");
        await query(
          `INSERT INTO document_templates
             (id, tenant_id, kind, name, description, body, sections, style, is_default, created_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,false,$9)`,
          [id, user.tenantId, kind, name, description, sectionsToBody(sections), JSON.stringify(sections), style, user.id],
        );
        return res.status(201).json({ ok: true, id });
      }

      // ---- template: update ----
      if (op === "update_template") {
        if (!canManageTemplates(user.role)) return res.status(403).json({ error: "forbidden" });
        const row = await loadTemplateRow(user.tenantId, String(body.id ?? ""));
        if (!row) return res.status(404).json({ error: "template_not_found" });
        const kind = asKind(row.kind);
        const gate = ensureKind(kind);
        if (gate) return res.status(403).json({ error: gate });
        const name = body.name != null ? String(body.name).trim() || row.name : row.name;
        const description = body.description != null ? String(body.description) : row.description;
        const style = body.style != null ? coerceStyle(body.style) : coerceStyle(row.style);
        const sections =
          body.sections != null ? normalizeSections(kind, body.sections) : rowToTemplate(row).sections;
        await query(
          `UPDATE document_templates
              SET name=$1, description=$2, style=$3, sections=$4::jsonb, body=$5, updated_at=now()
            WHERE tenant_id=$6 AND id=$7`,
          [name, description, style, JSON.stringify(sections), sectionsToBody(sections), user.tenantId, row.id],
        );
        return res.status(200).json({ ok: true, id: row.id });
      }

      // ---- template: duplicate ----
      if (op === "duplicate_template") {
        if (!canManageTemplates(user.role)) return res.status(403).json({ error: "forbidden" });
        const row = await loadTemplateRow(user.tenantId, String(body.id ?? ""));
        if (!row) return res.status(404).json({ error: "template_not_found" });
        const t = rowToTemplate(row);
        const gate = ensureKind(t.kind);
        if (gate) return res.status(403).json({ error: gate });
        const id = uid("tpl");
        await query(
          `INSERT INTO document_templates
             (id, tenant_id, kind, name, description, body, sections, style, is_default, created_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,false,$9)`,
          [id, user.tenantId, t.kind, `${t.name} (copy)`, t.description, sectionsToBody(t.sections), JSON.stringify(t.sections), t.style, user.id],
        );
        return res.status(201).json({ ok: true, id });
      }

      // ---- template: delete ----
      if (op === "delete_template") {
        if (!canManageTemplates(user.role)) return res.status(403).json({ error: "forbidden" });
        await query(`DELETE FROM document_templates WHERE tenant_id = $1 AND id = $2`, [
          user.tenantId,
          String(body.id ?? ""),
        ]);
        return res.status(200).json({ ok: true });
      }

      // ---- section ops (scope = template | document) ----
      if (op === "section_add" || op === "section_update" || op === "section_delete" || op === "section_reorder") {
        const scope = body.scope === "document" ? "document" : "template";

        if (scope === "template") {
          if (!canManageTemplates(user.role)) return res.status(403).json({ error: "forbidden" });
          const row = await loadTemplateRow(user.tenantId, String(body.id ?? ""));
          if (!row) return res.status(404).json({ error: "template_not_found" });
          const t = rowToTemplate(row);
          const gate = ensureKind(t.kind);
          if (gate) return res.status(403).json({ error: gate });
          let next: DocumentSection[] = t.sections;
          if (op === "section_add") next = addSection(t.sections, t.kind, String(body.sectionType ?? "custom"), body.atIndex);
          else if (op === "section_update")
            next = updateSection(t.sections, String(body.sectionId ?? ""), { title: body.title, content: body.content, type: body.type }, t.kind);
          else if (op === "section_delete") next = deleteSection(t.sections, String(body.sectionId ?? ""));
          else if (op === "section_reorder") next = reorderSections(t.sections, body.orderedIds);
          await query(
            `UPDATE document_templates SET sections=$1::jsonb, body=$2, updated_at=now() WHERE tenant_id=$3 AND id=$4`,
            [JSON.stringify(next), sectionsToBody(next), user.tenantId, row.id],
          );
          return res.status(200).json({ ok: true, sections: next });
        }

        // scope === document
        const row = await loadDocumentRow(user, String(body.id ?? ""));
        if (!row) return res.status(404).json({ error: "document_not_found" });
        const d = rowToDocument(row);
        const gate = ensureKind(d.kind);
        if (gate) return res.status(403).json({ error: gate });
        let next: DocumentSection[] = d.sections;
        if (op === "section_add") next = addSection(d.sections, d.kind, String(body.sectionType ?? "custom"), body.atIndex);
        else if (op === "section_update")
          next = updateSection(d.sections, String(body.sectionId ?? ""), { title: body.title, content: body.content, type: body.type }, d.kind);
        else if (op === "section_delete") next = deleteSection(d.sections, String(body.sectionId ?? ""));
        else if (op === "section_reorder") next = reorderSections(d.sections, body.orderedIds);
        await query(
          `UPDATE documents SET sections=$1::jsonb, body=$2, updated_at=now() WHERE tenant_id=$3 AND id=$4`,
          [JSON.stringify(next), sectionsToBody(next), user.tenantId, row.id],
        );
        return res.status(200).json({ ok: true, sections: next });
      }

      // ---- create a client proposal/contract from a template (bake merge fields) ----
      if (op === "create") {
        if (!canCreateClientDoc(user.role)) return res.status(403).json({ error: "forbidden" });
        const kind = asKind(body.kind);
        const gate = ensureKind(kind);
        if (gate) return res.status(403).json({ error: gate });

        const resolved = await resolveClient(user, body.clientId ? String(body.clientId) : null);
        if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
        const client = resolved.client;

        // template sections (optional). Unknown template id -> 400 to avoid silent empties.
        let baseSections: DocumentSection[];
        let style = "modern";
        let templateId: string | null = null;
        if (body.templateId) {
          const trow = await loadTemplateRow(user.tenantId, String(body.templateId));
          if (!trow) return res.status(400).json({ error: "invalid_template" });
          const t = rowToTemplate(trow);
          baseSections = t.sections.length ? t.sections : defaultSections(kind);
          style = t.style;
          templateId = t.id;
        } else {
          baseSections = defaultSections(kind);
        }

        const business = await loadBusinessProfile(user.tenantId);
        if (business) style = (kind === "contract" ? business.contractStyle : business.proposalStyle) || style;
        const spId = client?.salesperson_id ?? user.salespersonId ?? null;
        const spName = await salespersonName(user.tenantId, spId, user.name ?? "");
        const ctx = mergeContextFor(business, client, spName);
        const baked = applySectionsMerge(baseSections, ctx);

        const id = uid("doc");
        const title =
          String(body.title ?? "").trim() ||
          `${kind === "contract" ? "Contract" : "Proposal"} — ${client?.company_name ?? "New"}`;
        const amount = Number(client?.setup_fee_amount ?? 0) + Number(client?.monthly_subscription_amount ?? 0);
        await query(
          `INSERT INTO documents
             (id, tenant_id, kind, title, client_id, salesperson_id, template_id, body, sections, style, status, amount, created_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'draft',$11,$12)`,
          [id, user.tenantId, kind, title, client?.id ?? null, spId, templateId, sectionsToBody(baked), JSON.stringify(baked), style, amount, user.id],
        );
        return res.status(201).json({ ok: true, id });
      }

      // ---- edit a client document (sections/title/style) ----
      if (op === "update_document") {
        const row = await loadDocumentRow(user, String(body.id ?? ""));
        if (!row) return res.status(404).json({ error: "document_not_found" });
        const d = rowToDocument(row);
        const gate = ensureKind(d.kind);
        if (gate) return res.status(403).json({ error: gate });
        const title = body.title != null ? String(body.title).trim() || d.title : d.title;
        const style = body.style != null ? coerceStyle(body.style) : d.style;
        const sections = body.sections != null ? normalizeSections(d.kind, body.sections) : d.sections;
        await query(
          `UPDATE documents SET title=$1, style=$2, sections=$3::jsonb, body=$4, updated_at=now() WHERE tenant_id=$5 AND id=$6`,
          [title, style, JSON.stringify(sections), sectionsToBody(sections), user.tenantId, row.id],
        );
        return res.status(200).json({ ok: true, id: row.id });
      }

      // ---- advance the lifecycle status (validated transitions) ----
      if (op === "set_status") {
        const row = await loadDocumentRow(user, String(body.id ?? ""));
        if (!row) return res.status(404).json({ error: "document_not_found" });
        const to = String(body.status ?? "");
        if (!isValidStatus(to)) return res.status(400).json({ error: "invalid_status" });
        const from = (row.status ?? "draft") as DocStatus;
        if (!canTransitionStatus(from, to)) return res.status(400).json({ error: "invalid_transition" });
        const stampCol =
          to === "sent" ? "sent_at" : to === "viewed" ? "viewed_at" : to === "signed" ? "signed_at" : to === "canceled" ? "canceled_at" : null;
        await query(
          `UPDATE documents SET status=$1, updated_at=now()${stampCol ? `, ${stampCol}=now()` : ""} WHERE tenant_id=$2 AND id=$3`,
          [to, user.tenantId, row.id],
        );
        return res.status(200).json({ ok: true });
      }

      // ---- preview: resolve merge fields + return branding for a clean layout ----
      if (op === "preview") {
        const scope = body.scope === "document" ? "document" : "template";
        const business = await loadBusinessProfile(user.tenantId);
        const resolved = await resolveClient(user, body.clientId ? String(body.clientId) : null);
        if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
        const client = resolved.client;

        if (scope === "template") {
          const row = await loadTemplateRow(user.tenantId, String(body.id ?? ""));
          if (!row) return res.status(404).json({ error: "template_not_found" });
          const t = rowToTemplate(row);
          const spName = await salespersonName(user.tenantId, client?.salesperson_id ?? user.salespersonId ?? null, user.name ?? "");
          const ctx = mergeContextFor(business, client, spName);
          return res.status(200).json({
            kind: t.kind,
            title: t.name,
            style: t.style,
            sections: applySectionsMerge(t.sections, ctx),
            branding: brandingOf(business),
          });
        }

        const row = await loadDocumentRow(user, String(body.id ?? ""));
        if (!row) return res.status(404).json({ error: "document_not_found" });
        const d = rowToDocument(row);
        // Document sections are already baked at creation; re-resolve defensively
        // against the doc's own client + current branding so any lingering tokens
        // still render. The row is already tenant/role-scoped by loadDocumentRow.
        let docClient = client;
        if (!docClient && d.clientId) {
          const r = await query<any>(`SELECT * FROM clients WHERE tenant_id = $1 AND id = $2`, [user.tenantId, d.clientId]);
          docClient = r.rows[0] ?? null;
        }
        const spName = await salespersonName(user.tenantId, d.salespersonId, user.name ?? "");
        const ctx = mergeContextFor(business, docClient, spName);
        return res.status(200).json({
          kind: d.kind,
          title: d.title,
          style: d.style,
          status: d.status,
          sections: applySectionsMerge(d.sections, ctx),
          branding: brandingOf(business),
        });
      }

      return res.status(400).json({ error: "unknown_op" });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
