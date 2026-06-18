// /api/ai — server-side OpenAI generation for proposals, contracts, sections,
// and follow-up emails. The API key is read from the environment and NEVER sent
// to the browser; every model call happens here.
//
//   GET                       -> { configured, model }   (AI availability)
//   GET ?resource=history     -> { history }              (role-scoped)
//   POST { op:'generate', kind, target, clientId?, instructions?, sectionType? }
//        -> { title, sections }   (also appended to ai_generated_content)
//
// GATING: requires the tenant `ai` feature (403 ai_disabled if off). If no key is
// configured, generation returns 409 ai_not_configured so the UI can show a clear
// "AI is not configured" message while manual templates keep working. Tenant +
// user come from the session; history is tenant-scoped and role-filtered.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { hasDb, query } from "./_lib/db.js";
import { ensureSchema, seedIfEmpty } from "./_lib/repository.js";
import { getSessionUser } from "./_lib/auth.js";
import { readTenantFlags } from "./_lib/feature-access.js";
import {
  aiConfigured,
  aiModel,
  buildGenerationMessages,
  parseAiSections,
  rowToBusinessProfile,
  isSelfRole,
  type GenerateInput,
} from "./_lib/documents-core.js";
import type { AiTarget, DocumentKind, SectionType } from "../src/types/index.js";

const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const asKind = (v: unknown): DocumentKind => (v === "contract" ? "contract" : "proposal");
const TARGETS: AiTarget[] = ["template", "document", "section", "email"];
const asTarget = (v: unknown): AiTarget => (TARGETS.includes(v as AiTarget) ? (v as AiTarget) : "template");

/** Map a generation request to the kind label stored in history. */
function historyKind(kind: DocumentKind, target: AiTarget): string {
  if (target === "email") return "email";
  if (target === "section") return "section";
  return kind;
}

/** Call the OpenAI chat-completions API; returns the assistant message text. */
async function callOpenAI(apiKey: string, model: string, system: string, userMsg: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      const err: any = new Error(`openai_${resp.status}`);
      err.status = resp.status;
      err.detail = detail.slice(0, 500);
      throw err;
    }
    const data: any = await resp.json();
    return data?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!hasDb()) return res.status(503).json({ error: "database_not_configured" });
  try {
    await ensureSchema();
    await seedIfEmpty();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: "unauthorized" });

    const env = process.env as Record<string, string | undefined>;

    if (req.method === "GET") {
      // AI history (role-scoped), or availability status.
      if (String(req.query.resource ?? "") === "history") {
        let sql = `SELECT * FROM ai_generated_content WHERE tenant_id = $1`;
        const params: any[] = [user.tenantId];
        if (user.role === "sales_manager") {
          sql += ` AND (salesperson_id IN (SELECT id FROM salespeople WHERE tenant_id = $1 AND manager_user_id = $2) OR user_id = $2)`;
          params.push(user.id);
        } else if (isSelfRole(user.role)) {
          sql += ` AND (salesperson_id = $2 OR user_id = $3)`;
          params.push(user.salespersonId ?? "__none__", user.id);
        }
        sql += ` ORDER BY created_at DESC LIMIT 100`;
        const { rows } = await query<any>(sql, params);
        const history = rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          target: r.target,
          title: r.title ?? "",
          prompt: r.prompt ?? "",
          content: typeof r.content === "string" ? safeParse(r.content) : r.content ?? null,
          model: r.model ?? "",
          clientId: r.client_id ?? null,
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : "",
        }));
        return res.status(200).json({ history });
      }
      return res.status(200).json({ configured: aiConfigured(env), model: aiModel(env) });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
      const op = String(body.op ?? "generate");
      if (op !== "generate") return res.status(400).json({ error: "unknown_op" });

      // Feature gate: AI must be enabled for the tenant.
      const flags = await readTenantFlags(user.tenantId);
      if (flags.ai === false) return res.status(403).json({ error: "ai_disabled" });

      // Manual mode: no key -> clear, non-crashing signal for the UI.
      if (!aiConfigured(env)) return res.status(409).json({ error: "ai_not_configured" });

      const kind = asKind(body.kind);
      const target = asTarget(body.target);

      // Resolve optional client (tenant-scoped; self roles must own it).
      let client: { companyName?: string; contactName?: string } | null = null;
      let clientId: string | null = null;
      if (body.clientId) {
        const { rows } = await query<any>(`SELECT * FROM clients WHERE tenant_id = $1 AND id = $2`, [
          user.tenantId,
          String(body.clientId),
        ]);
        const c = rows[0];
        if (!c) return res.status(400).json({ error: "invalid_client" });
        if (isSelfRole(user.role) && c.salesperson_id !== user.salespersonId) {
          return res.status(403).json({ error: "client_not_yours" });
        }
        client = { companyName: c.company_name, contactName: c.contact_name };
        clientId = c.id;
      }

      // Current business profile for grounding the prompt.
      const bp = await query<any>(`SELECT * FROM business_profiles WHERE tenant_id = $1`, [user.tenantId]);
      const business = bp.rows[0] ? rowToBusinessProfile(bp.rows[0]) : null;

      const genInput: GenerateInput = {
        kind,
        target,
        business,
        client,
        instructions: typeof body.instructions === "string" ? body.instructions : "",
        sectionType: typeof body.sectionType === "string" ? (body.sectionType as SectionType) : undefined,
      };
      const { system, user: userMsg } = buildGenerationMessages(genInput);
      const model = aiModel(env);
      const apiKey = (env.OPENAI_API_KEY ?? env.OPENAI_KEY ?? "").trim();

      let raw: string;
      try {
        raw = await callOpenAI(apiKey, model, system, userMsg);
      } catch (e: any) {
        if (e?.name === "AbortError") return res.status(504).json({ error: "ai_timeout" });
        return res.status(502).json({ error: "ai_request_failed", detail: e?.detail ?? String(e?.message ?? e) });
      }

      const { title, sections } = parseAiSections(raw, kind);

      // Append to history (best-effort; a logging failure must not lose output).
      try {
        await query(
          `INSERT INTO ai_generated_content
             (id, tenant_id, user_id, salesperson_id, kind, target, title, prompt, content, model, client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
          [
            uid("ai"),
            user.tenantId,
            user.id,
            user.salespersonId ?? null,
            historyKind(kind, target),
            target,
            title,
            (genInput.instructions ?? "").slice(0, 2000),
            JSON.stringify({ sections }),
            model,
            clientId,
          ],
        );
      } catch {
        /* history is best-effort */
      }

      return res.status(200).json({ title, sections });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
