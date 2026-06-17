// /api/documents — proposals, contracts, and their templates.
//
//   GET                      -> { templates, documents } scoped to the tenant
//                               (self roles see only their own clients' docs)
//   POST { op:'create_template', kind, name, body }
//   POST { op:'create', kind, clientId, templateId, title }
//   POST { op:'set_status', id, status }   status: draft|sent|viewed|signed|canceled
//
// SECURITY: tenant comes from the session, never the client. Every read/write
// is filtered by tenant_id, so a document can never cross sub-accounts. These
// rows are server-owned and are not touched by the /api/state snapshot save.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser } from "./_lib/auth.js";

const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const SELF_ROLES = ["salesperson", "affiliate", "partner"];
const VALID_STATUS = ["draft", "sent", "viewed", "signed", "canceled"];

const DEFAULT_TEMPLATES: Array<{ kind: string; name: string; body: string }> = [
  {
    kind: "proposal",
    name: "Standard Service Proposal",
    body:
      "PROPOSAL FOR {{company}}\n\nPrepared for: {{contact}}\n\nWe're excited to partner with {{company}}. This proposal covers a one-time setup of {{setup_fee}} and an ongoing subscription of {{monthly}} per month.\n\nScope of work:\n  • Onboarding & account configuration\n  • Ongoing management and reporting\n  • Dedicated support\n\nThis proposal is valid for 30 days.",
  },
  {
    kind: "contract",
    name: "Standard Service Agreement",
    body:
      "SERVICE AGREEMENT\n\nThis agreement is entered into between our company and {{company}} (\"Client\"), contact {{contact}}.\n\n1. Fees. Client agrees to a setup fee of {{setup_fee}} and a recurring monthly fee of {{monthly}}.\n2. Term. Month-to-month, cancellable with 30 days' notice.\n3. Services. As described in the accepted proposal.\n\nBy signing below, both parties agree to the terms above.",
  },
];

/** Create the two starter templates once per tenant so the UI is never empty. */
async function ensureDefaultTemplates(tenantId: string): Promise<void> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM document_templates WHERE tenant_id = $1`,
    [tenantId],
  );
  if (Number(rows[0]?.n ?? 0) > 0) return;
  for (const t of DEFAULT_TEMPLATES) {
    await query(
      `INSERT INTO document_templates (id, tenant_id, kind, name, body, is_default)
       VALUES ($1,$2,$3,$4,$5,true)`,
      [uid("tpl"), tenantId, t.kind, t.name, t.body],
    );
  }
}

function fillTokens(body: string, client: any | null): string {
  const money = (n: any) =>
    Number(n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  return body
    .replace(/\{\{company\}\}/g, client?.company_name || "the client")
    .replace(/\{\{contact\}\}/g, client?.contact_name || "—")
    .replace(/\{\{setup_fee\}\}/g, money(client?.setup_fee_amount))
    .replace(/\{\{monthly\}\}/g, money(client?.monthly_subscription_amount));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    await ensureDefaultTemplates(user.tenantId);

    if (req.method === "GET") {
      const templatesRes = await query<any>(
        `SELECT * FROM document_templates WHERE tenant_id = $1 ORDER BY kind, name`,
        [user.tenantId],
      );

      let docsSql = `SELECT * FROM documents WHERE tenant_id = $1`;
      const params: any[] = [user.tenantId];
      if (user.role === "sales_manager") {
        docsSql += ` AND salesperson_id IN (SELECT id FROM salespeople WHERE tenant_id = $1 AND manager_user_id = $2)`;
        params.push(user.id);
      } else if (SELF_ROLES.includes(user.role)) {
        docsSql += ` AND salesperson_id = $2`;
        params.push(user.salespersonId ?? "__none__");
      }
      docsSql += ` ORDER BY created_at DESC`;
      const docsRes = await query<any>(docsSql, params);

      return res.status(200).json({ templates: templatesRes.rows, documents: docsRes.rows });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
      const op = String(body.op ?? "");

      // --- create a template (admins/managers) ---
      if (op === "create_template") {
        if (![ "owner", "admin", "sales_manager" ].includes(user.role)) {
          return res.status(403).json({ error: "forbidden" });
        }
        const kind = body.kind === "contract" ? "contract" : "proposal";
        const name = String(body.name ?? "").trim() || `Untitled ${kind}`;
        const id = uid("tpl");
        await query(
          `INSERT INTO document_templates (id, tenant_id, kind, name, body, is_default)
           VALUES ($1,$2,$3,$4,$5,false)`,
          [id, user.tenantId, kind, name, String(body.body ?? "")],
        );
        return res.status(201).json({ ok: true, id });
      }

      // --- create a proposal/contract for a client ---
      if (op === "create") {
        const kind = body.kind === "contract" ? "contract" : "proposal";
        const clientId = body.clientId ? String(body.clientId) : null;

        // resolve the client (must be in this tenant; self roles must own it)
        let client: any = null;
        if (clientId) {
          const { rows } = await query<any>(
            `SELECT * FROM clients WHERE tenant_id = $1 AND id = $2`,
            [user.tenantId, clientId],
          );
          client = rows[0] ?? null;
          if (!client) return res.status(400).json({ error: "invalid_client" });
          if (SELF_ROLES.includes(user.role) && client.salesperson_id !== user.salespersonId) {
            return res.status(403).json({ error: "client_not_yours" });
          }
        }

        // resolve the template body (optional)
        let tplBody = "";
        if (body.templateId) {
          const { rows } = await query<any>(
            `SELECT body FROM document_templates WHERE tenant_id = $1 AND id = $2`,
            [user.tenantId, String(body.templateId)],
          );
          tplBody = rows[0]?.body ?? "";
        }

        const id = uid("doc");
        const title =
          String(body.title ?? "").trim() ||
          `${kind === "contract" ? "Contract" : "Proposal"} — ${client?.company_name ?? "New"}`;
        await query(
          `INSERT INTO documents
             (id, tenant_id, kind, title, client_id, salesperson_id, template_id, body, status, amount, created_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10)`,
          [
            id, user.tenantId, kind, title, clientId,
            client?.salesperson_id ?? user.salespersonId ?? null,
            body.templateId ? String(body.templateId) : null,
            fillTokens(tplBody, client),
            Number(client?.setup_fee_amount ?? 0) + Number(client?.monthly_subscription_amount ?? 0),
            user.id,
          ],
        );
        return res.status(201).json({ ok: true, id });
      }

      // --- advance the lifecycle status ---
      if (op === "set_status") {
        const id = String(body.id ?? "");
        const status = String(body.status ?? "");
        if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: "invalid_status" });
        // self roles may only touch their own documents
        const guard = SELF_ROLES.includes(user.role) ? ` AND salesperson_id = '${user.salespersonId ?? "__none__"}'` : "";
        const stampCol =
          status === "sent" ? "sent_at" : status === "viewed" ? "viewed_at" : status === "signed" ? "signed_at" : status === "canceled" ? "canceled_at" : null;
        await query(
          `UPDATE documents SET status = $1, updated_at = now()${stampCol ? `, ${stampCol} = now()` : ""}
            WHERE tenant_id = $2 AND id = $3${guard}`,
          [status, user.tenantId, id],
        );
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: "unknown_op" });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
