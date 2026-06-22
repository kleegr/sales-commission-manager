// ============================================================================
// KLEEGR SYNC  —  database mapping + idempotent sync (server-side only)
//
// Bridges Kleegr Smart Productivity data onto our tenant-scoped tables. Every
// write here is TENANT-SCOPED (one tenant == one Kleegr sub-account == one GHL
// location), IDEMPOTENT (rows matched/UPSERTed by their Kleegr/GHL ids so a
// re-launch or repeated webhook never duplicates), and NON-DESTRUCTIVE
// (imported rows are LABELLED via kleegr_source and we never blindly overwrite
// manually-entered business data — we link to it).
//
// There are NO direct GoHighLevel calls here; all external reads come through
// the Kleegr gateway (kleegr.ts). The "first sync" is deliberately small.
// ============================================================================

import { query } from "./db.js";
import {
  gatewaySubaccount,
  gatewayUsers,
  gatewayContacts,
  gatewayOpportunities,
  mapKleegrRole,
  KleegrError,
  type LaunchClaims,
  type AppRole,
  type IntegrationStatus,
} from "./kleegr.js";

const nowISO = () => new Date().toISOString();
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function slugSafe(s: string, max = 40): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "x";
}
function idSafe(s: string, max = 48): string {
  return String(s).replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, max) || "x";
}

/** How many records the FIRST sync pulls per resource (kept intentionally small). */
const SYNC_LIMIT = 50;

// ---------------------------------------------------------------------------
// Tenant (sub-account) mapping
// ---------------------------------------------------------------------------

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  ghl_location_id: string | null;
  kleegr_sub_account_id: string | null;
  kleegr_connection_status: string | null;
}

const TENANT_COLS = "id, name, slug, ghl_location_id, kleegr_sub_account_id, kleegr_connection_status";

/**
 * Resolve (or create) the tenant for a Kleegr sub-account, idempotently:
 *   1. an existing tenant linked to this kleegr_sub_account_id;
 *   2. an existing tenant for this GHL location not yet linked (attach, don't dup);
 *   3. a new tenant.
 */
export async function upsertTenantForSubAccount(opts: {
  subAccountId: string;
  locationId: string | null;
  name?: string | null;
}): Promise<TenantRow> {
  const { subAccountId, locationId } = opts;
  const name = (opts.name ?? "").trim();

  const linked = await query<TenantRow>(
    `SELECT ${TENANT_COLS} FROM tenants WHERE kleegr_sub_account_id = $1 LIMIT 1`,
    [subAccountId],
  );
  if (linked.rows[0]) {
    const t = linked.rows[0];
    await query(
      `UPDATE tenants SET
          ghl_location_id          = COALESCE($2, ghl_location_id),
          name                     = CASE WHEN $3 <> '' THEN $3 ELSE name END,
          kleegr_connection_status = 'connected',
          kleegr_connected_at      = COALESCE(kleegr_connected_at, now()),
          updated_at               = now()
        WHERE id = $1`,
      [t.id, locationId, name],
    );
    return { ...t, ghl_location_id: locationId ?? t.ghl_location_id, kleegr_connection_status: "connected" };
  }

  if (locationId) {
    const byLoc = await query<TenantRow>(
      `SELECT ${TENANT_COLS} FROM tenants
        WHERE ghl_location_id = $1 AND kleegr_sub_account_id IS NULL LIMIT 1`,
      [locationId],
    );
    if (byLoc.rows[0]) {
      const t = byLoc.rows[0];
      await query(
        `UPDATE tenants SET
            kleegr_sub_account_id    = $2,
            kleegr_connection_status = 'connected',
            kleegr_connected_at      = now(),
            name                     = CASE WHEN $3 <> '' THEN $3 ELSE name END,
            updated_at               = now()
          WHERE id = $1`,
        [t.id, subAccountId, name],
      );
      return { ...t, kleegr_sub_account_id: subAccountId, kleegr_connection_status: "connected" };
    }
  }

  const id = `tenant_k_${idSafe(subAccountId)}`;
  let slug = `k-${slugSafe(subAccountId)}`;
  const clash = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM tenants WHERE slug = $1 AND id <> $2`,
    [slug, id],
  );
  if (Number(clash.rows[0]?.n ?? 0) > 0) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

  await query(
    `INSERT INTO tenants
        (id, name, slug, ghl_location_id, kleegr_sub_account_id, status,
         kleegr_connection_status, kleegr_connected_at, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,'active','connected', now(), now(), now())
      ON CONFLICT (id) DO UPDATE SET
        ghl_location_id = COALESCE(EXCLUDED.ghl_location_id, tenants.ghl_location_id),
        kleegr_connection_status = 'connected',
        updated_at = now()`,
    [id, name || `Kleegr ${subAccountId}`, slug, locationId, subAccountId],
  );
  return {
    id, name: name || `Kleegr ${subAccountId}`, slug,
    ghl_location_id: locationId, kleegr_sub_account_id: subAccountId, kleegr_connection_status: "connected",
  };
}

export async function resolveTenantBySubAccount(subAccountId: string): Promise<TenantRow | null> {
  const { rows } = await query<TenantRow>(
    `SELECT ${TENANT_COLS} FROM tenants WHERE kleegr_sub_account_id = $1 LIMIT 1`,
    [subAccountId],
  );
  return rows[0] ?? null;
}

export async function setConnectionStatus(tenantId: string, status: IntegrationStatus): Promise<void> {
  await query(`UPDATE tenants SET kleegr_connection_status = $2, updated_at = now() WHERE id = $1`, [tenantId, status]);
}

export async function touchLastSync(tenantId: string): Promise<void> {
  await query(`UPDATE tenants SET kleegr_last_sync_at = now(), updated_at = now() WHERE id = $1`, [tenantId]);
}

// ---------------------------------------------------------------------------
// User mapping (the launched person)
// ---------------------------------------------------------------------------

export interface AppUserRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  role: string;
  salesperson_id: string | null;
}

/**
 * Resolve (or create) the app user for a launched Kleegr user, idempotently.
 * Matches by kleegr_user_id, then by email within the tenant (link, don't dup).
 */
export async function upsertUserForClaims(
  tenantId: string,
  claims: LaunchClaims,
  mappedRole: AppRole,
): Promise<AppUserRow> {
  const email = (claims.email ?? "").trim().toLowerCase();
  const name = email ? email.split("@")[0] : `Kleegr ${claims.sp_user_id}`;
  const permsJson = JSON.stringify(claims.permissions ?? []);

  const byKleegr = await query<AppUserRow>(
    `SELECT id, tenant_id, name, email, role, salesperson_id
       FROM users WHERE tenant_id = $1 AND kleegr_user_id = $2 LIMIT 1`,
    [tenantId, claims.sp_user_id],
  );
  if (byKleegr.rows[0]) {
    const u = byKleegr.rows[0];
    await query(
      `UPDATE users SET role = $2, kleegr_role = $3, kleegr_permissions = $4::jsonb,
          email = CASE WHEN $5 <> '' THEN $5 ELSE email END,
          last_login_at = now(), updated_at = now()
        WHERE id = $1`,
      [u.id, mappedRole, claims.role ?? null, permsJson, email],
    );
    return { ...u, role: mappedRole };
  }

  if (email) {
    const byEmail = await query<AppUserRow>(
      `SELECT id, tenant_id, name, email, role, salesperson_id
         FROM users WHERE tenant_id = $1 AND lower(email) = $2 LIMIT 1`,
      [tenantId, email],
    );
    if (byEmail.rows[0]) {
      const u = byEmail.rows[0];
      await query(
        `UPDATE users SET kleegr_user_id = $2, kleegr_role = $3, kleegr_permissions = $4::jsonb,
            role = $5, last_login_at = now(), updated_at = now()
          WHERE id = $1`,
        [u.id, claims.sp_user_id, claims.role ?? null, permsJson, mappedRole],
      );
      return { ...u, role: mappedRole };
    }
  }

  const id = `user_k_${idSafe(claims.sp_user_id)}`;
  const safeEmail = email || `${idSafe(claims.sp_user_id)}@kleegr.local`;
  await query(
    `INSERT INTO users
        (id, tenant_id, name, email, role, status, kleegr_user_id, kleegr_role,
         kleegr_permissions, last_login_at, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8::jsonb, now(), now(), now())
      ON CONFLICT (tenant_id, email) DO UPDATE SET
        kleegr_user_id = EXCLUDED.kleegr_user_id, kleegr_role = EXCLUDED.kleegr_role,
        kleegr_permissions = EXCLUDED.kleegr_permissions, role = EXCLUDED.role,
        last_login_at = now(), updated_at = now()`,
    [id, tenantId, name, safeEmail, mappedRole, claims.sp_user_id, claims.role ?? null, permsJson],
  );
  const created = await query<AppUserRow>(
    `SELECT id, tenant_id, name, email, role, salesperson_id
       FROM users WHERE tenant_id = $1 AND lower(email) = $2 LIMIT 1`,
    [tenantId, safeEmail.toLowerCase()],
  );
  return created.rows[0] ?? { id, tenant_id: tenantId, name, email: safeEmail, role: mappedRole, salesperson_id: null };
}

// ---------------------------------------------------------------------------
// Defensive normalizers for gateway / webhook payloads
// ---------------------------------------------------------------------------

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}
function firstNumber(...vals: unknown[]): number | null {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/** Pull an array of records out of common envelope shapes. */
export function asRecordList(data: unknown, ...keys: string[]): any[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const k of [...keys, "items", "data", "results"]) {
      if (Array.isArray(obj[k])) return obj[k] as any[];
    }
  }
  return [];
}

export interface NormContact {
  kleegrContactId: string | null; ghlContactId: string | null;
  companyName: string; contactName: string; email: string; phone: string;
}
export function normalizeContact(c: any): NormContact | null {
  if (!c || typeof c !== "object") return null;
  const kleegrContactId = firstString(c.id, c.contactId, c.contact_id, c.kleegr_contact_id);
  const ghlContactId = firstString(c.ghlContactId, c.ghl_contact_id, c.ghlId, c.id);
  const contactName = firstString(c.name, [c.firstName, c.lastName].filter(Boolean).join(" "), c.contactName) ?? "";
  const companyName = firstString(c.companyName, c.company, c.businessName) ?? "";
  const email = firstString(c.email, c.emailAddress) ?? "";
  const phone = firstString(c.phone, c.phoneNumber) ?? "";
  if (!kleegrContactId && !ghlContactId && !email) return null;
  return { kleegrContactId, ghlContactId, companyName, contactName, email, phone };
}

export interface NormOpp {
  kleegrOpportunityId: string | null; ghlOpportunityId: string | null;
  contactRef: string | null; name: string;
  pipelineId: string | null; stageId: string | null; status: string | null; monetaryValue: number | null;
}
export function normalizeOpportunity(o: any): NormOpp | null {
  if (!o || typeof o !== "object") return null;
  const kleegrOpportunityId = firstString(o.id, o.opportunityId, o.opportunity_id, o.kleegr_opportunity_id);
  const ghlOpportunityId = firstString(o.ghlOpportunityId, o.ghl_opportunity_id, o.id);
  const contactRef = firstString(o.contactId, o.contact_id, o.kleegr_contact_id, o.ghl_contact_id);
  const name = firstString(o.name, o.title) ?? "";
  const pipelineId = firstString(o.pipelineId, o.pipeline_id);
  const stageId = firstString(o.pipelineStageId, o.stageId, o.stage_id, o.pipeline_stage_id);
  const status = firstString(o.status, o.opportunityStatus);
  const monetaryValue = firstNumber(o.monetaryValue, o.value, o.amount);
  if (!kleegrOpportunityId && !ghlOpportunityId) return null;
  return { kleegrOpportunityId, ghlOpportunityId, contactRef, name, pipelineId, stageId, status, monetaryValue };
}

// ---------------------------------------------------------------------------
// Client (contact + opportunity) upserts — idempotent, non-destructive
// ---------------------------------------------------------------------------

export async function upsertContactAsClient(tenantId: string, c: NormContact): Promise<"created" | "linked" | "updated"> {
  const match = await query<{ id: string; kleegr_source: string | null }>(
    `SELECT id, kleegr_source FROM clients
       WHERE tenant_id = $1 AND (
         (kleegr_contact_id IS NOT NULL AND kleegr_contact_id = $2) OR
         (ghl_contact_id    IS NOT NULL AND ghl_contact_id    = $3))
       LIMIT 1`,
    [tenantId, c.kleegrContactId, c.ghlContactId],
  );

  if (match.rows[0]) {
    const existing = match.rows[0];
    const source = existing.kleegr_source === "kleegr_imported" ? "kleegr_imported" : "kleegr_linked";
    await query(
      `UPDATE clients SET
          kleegr_contact_id = COALESCE($2, kleegr_contact_id),
          ghl_contact_id    = COALESCE($3, ghl_contact_id),
          kleegr_source     = $4,
          company_name = CASE WHEN company_name = '' THEN $5 ELSE company_name END,
          contact_name = CASE WHEN contact_name = '' THEN $6 ELSE contact_name END,
          email        = CASE WHEN email = ''        THEN $7 ELSE email END,
          phone        = CASE WHEN phone = ''        THEN $8 ELSE phone END,
          updated_at = $9
        WHERE id = $1 AND tenant_id = $10`,
      [existing.id, c.kleegrContactId, c.ghlContactId, source, c.companyName, c.contactName, c.email, c.phone, nowISO(), tenantId],
    );
    return existing.kleegr_source ? "updated" : "linked";
  }

  const id = c.kleegrContactId ? `cli_k_${idSafe(c.kleegrContactId)}` : `cli_g_${idSafe(c.ghlContactId ?? uid("c"))}`;
  await query(
    `INSERT INTO clients
        (id, tenant_id, salesperson_id, company_name, contact_name, email, phone, signup_date,
         setup_fee_amount, monthly_subscription_amount, status, notes,
         ghl_contact_id, kleegr_contact_id, kleegr_source, created_at, updated_at)
      VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,0,0,'active','',$8,$9,'kleegr_imported',$10,$10)
      ON CONFLICT (id) DO UPDATE SET
        kleegr_contact_id = EXCLUDED.kleegr_contact_id,
        ghl_contact_id    = COALESCE(EXCLUDED.ghl_contact_id, clients.ghl_contact_id),
        updated_at = EXCLUDED.updated_at`,
    [id, tenantId, c.companyName, c.contactName, c.email, c.phone, nowISO().slice(0, 10), c.ghlContactId, c.kleegrContactId, nowISO()],
  );
  return "created";
}

export async function upsertOpportunity(tenantId: string, o: NormOpp): Promise<"linked" | "created" | "updated"> {
  let clientId: string | null = null;
  if (o.contactRef) {
    const byContact = await query<{ id: string }>(
      `SELECT id FROM clients WHERE tenant_id = $1 AND (kleegr_contact_id = $2 OR ghl_contact_id = $2) LIMIT 1`,
      [tenantId, o.contactRef],
    );
    clientId = byContact.rows[0]?.id ?? null;
  }
  if (!clientId) {
    const byOpp = await query<{ id: string }>(
      `SELECT id FROM clients WHERE tenant_id = $1 AND
         ((kleegr_opportunity_id IS NOT NULL AND kleegr_opportunity_id = $2) OR
          (ghl_opportunity_id    IS NOT NULL AND ghl_opportunity_id    = $3)) LIMIT 1`,
      [tenantId, o.kleegrOpportunityId, o.ghlOpportunityId],
    );
    clientId = byOpp.rows[0]?.id ?? null;
  }

  if (!clientId) {
    // No matching contact/opportunity → create a shell client to hold the deal.
    const id = `cli_opp_${idSafe(o.kleegrOpportunityId ?? o.ghlOpportunityId ?? uid("o"))}`;
    await query(
      `INSERT INTO clients
          (id, tenant_id, salesperson_id, company_name, contact_name, email, phone, signup_date,
           setup_fee_amount, monthly_subscription_amount, status, notes,
           kleegr_opportunity_id, ghl_opportunity_id, pipeline_id, stage_id, opportunity_status,
           kleegr_source, created_at, updated_at)
        VALUES ($1,$2,NULL,$3,'','','',$4,0,$5,'active','',$6,$7,$8,$9,$10,'kleegr_imported',$11,$11)
        ON CONFLICT (id) DO UPDATE SET
          kleegr_opportunity_id = EXCLUDED.kleegr_opportunity_id,
          pipeline_id = EXCLUDED.pipeline_id, stage_id = EXCLUDED.stage_id,
          opportunity_status = EXCLUDED.opportunity_status, updated_at = EXCLUDED.updated_at`,
      [id, tenantId, o.name, nowISO().slice(0, 10), o.monetaryValue ?? 0,
       o.kleegrOpportunityId, o.ghlOpportunityId, o.pipelineId, o.stageId, o.status, nowISO()],
    );
    return "created";
  }

  await query(
    `UPDATE clients SET
        kleegr_opportunity_id = COALESCE($2, kleegr_opportunity_id),
        ghl_opportunity_id    = COALESCE($3, ghl_opportunity_id),
        pipeline_id           = COALESCE($4, pipeline_id),
        stage_id              = COALESCE($5, stage_id),
        opportunity_status    = COALESCE($6, opportunity_status),
        kleegr_source         = CASE WHEN kleegr_source = 'kleegr_imported' THEN 'kleegr_imported' ELSE 'kleegr_linked' END,
        updated_at            = $7
      WHERE id = $1 AND tenant_id = $8`,
    [clientId, o.kleegrOpportunityId, o.ghlOpportunityId, o.pipelineId, o.stageId, o.status, nowISO(), tenantId],
  );
  return "linked";
}

// ---------------------------------------------------------------------------
// Step 8 — safe, idempotent FIRST sync via the Kleegr gateway
// ---------------------------------------------------------------------------

export type ResourceOutcome = "ok" | "denied" | "unavailable" | "upstream_error" | "error";

export interface SyncSummary {
  startedAt: string;
  finishedAt: string;
  subaccount: ResourceOutcome;
  users: { count: number; outcome: ResourceOutcome };
  contacts: { created: number; linked: number; updated: number; outcome: ResourceOutcome };
  opportunities: { created: number; linked: number; outcome: ResourceOutcome };
  notes: string[];
}

function outcomeFor(err: unknown): ResourceOutcome {
  if (err instanceof KleegrError) {
    if (err.code === "gateway_denied") return "denied";
    if (err.code === "not_implemented") return "unavailable";
    if (err.code === "ghl_upstream_error") return "upstream_error";
  }
  return "error";
}

/**
 * Pull subaccount → users → contacts → opportunities and map them onto this
 * tenant. Each resource is isolated: a 403/501/502 on one does not abort the
 * rest; it is recorded in the summary and sync continues. Uses the short-lived
 * launch token (never persisted) supplied by the launch flow.
 */
export async function runInitialSync(opts: {
  launchToken: string;
  tenantId: string;
  fetchImpl?: typeof fetch;
}): Promise<SyncSummary> {
  const { launchToken, tenantId, fetchImpl } = opts;
  const startedAt = nowISO();
  const notes: string[] = [];
  const summary: SyncSummary = {
    startedAt,
    finishedAt: startedAt,
    subaccount: "ok",
    users: { count: 0, outcome: "ok" },
    contacts: { created: 0, linked: 0, updated: 0, outcome: "ok" },
    opportunities: { created: 0, linked: 0, outcome: "ok" },
    notes,
  };

  // 1. subaccount profile → refresh tenant name/location
  try {
    const sub = await gatewaySubaccount<any>(launchToken, fetchImpl);
    const name = firstString(sub?.name, sub?.businessName, sub?.companyName);
    const loc = firstString(sub?.locationId, sub?.location_id, sub?.id);
    if (name || loc) {
      await query(
        `UPDATE tenants SET
            name = CASE WHEN $2 <> '' THEN $2 ELSE name END,
            ghl_location_id = COALESCE($3, ghl_location_id),
            updated_at = now()
          WHERE id = $1`,
        [tenantId, name ?? "", loc],
      );
    }
  } catch (err) {
    summary.subaccount = outcomeFor(err);
    notes.push(`subaccount: ${err instanceof KleegrError ? err.code : "error"}`);
  }

  // 2. users → upsert app users (best effort; sales roles only get a login)
  try {
    const data = await gatewayUsers<any>(launchToken, { limit: SYNC_LIMIT }, fetchImpl);
    const list = asRecordList(data, "users").slice(0, SYNC_LIMIT);
    for (const raw of list) {
      const kleegrUserId = firstString(raw?.id, raw?.userId, raw?.user_id);
      const email = firstString(raw?.email, raw?.emailAddress);
      if (!kleegrUserId && !email) continue;
      const role = mapKleegrRole(firstString(raw?.role, raw?.type), "sub_account");
      await upsertUserForClaims(
        tenantId,
        {
          sp_user_id: kleegrUserId ?? `email:${email}`,
          email: email ?? null,
          role: firstString(raw?.role, raw?.type),
          permissions: [],
          sub_account_id: "",
          location_id: null,
          exp: null,
          raw: {},
        } as LaunchClaims,
        role,
      );
      summary.users.count++;
    }
  } catch (err) {
    summary.users.outcome = outcomeFor(err);
    notes.push(`users: ${err instanceof KleegrError ? err.code : "error"}`);
  }

  // 3. contacts → upsert clients
  try {
    const data = await gatewayContacts<any>(launchToken, { limit: SYNC_LIMIT }, fetchImpl);
    const list = asRecordList(data, "contacts").slice(0, SYNC_LIMIT);
    for (const raw of list) {
      const c = normalizeContact(raw);
      if (!c) continue;
      const r = await upsertContactAsClient(tenantId, c);
      if (r === "created") summary.contacts.created++;
      else if (r === "linked") summary.contacts.linked++;
      else summary.contacts.updated++;
    }
  } catch (err) {
    summary.contacts.outcome = outcomeFor(err);
    notes.push(`contacts: ${err instanceof KleegrError ? err.code : "error"}`);
  }

  // 4. opportunities → link/create onto clients
  try {
    const data = await gatewayOpportunities<any>(launchToken, { limit: SYNC_LIMIT }, fetchImpl);
    const list = asRecordList(data, "opportunities").slice(0, SYNC_LIMIT);
    for (const raw of list) {
      const o = normalizeOpportunity(raw);
      if (!o) continue;
      const r = await upsertOpportunity(tenantId, o);
      if (r === "created") summary.opportunities.created++;
      else summary.opportunities.linked++;
    }
  } catch (err) {
    summary.opportunities.outcome = outcomeFor(err);
    notes.push(`opportunities: ${err instanceof KleegrError ? err.code : "error"}`);
  }

  await touchLastSync(tenantId);
  summary.finishedAt = nowISO();
  return summary;
}

// ---------------------------------------------------------------------------
// Step 7 — webhook event recording (idempotent) + application
// ---------------------------------------------------------------------------

/** Extract a sub-account / location reference from a webhook payload. */
export function extractSubAccountId(payload: any): string | null {
  const p = payload && typeof payload === "object" ? payload : {};
  const d = p.data && typeof p.data === "object" ? p.data : {};
  return firstString(
    p.subAccountId, p.sub_account_id, p.locationId, p.location_id,
    d.subAccountId, d.sub_account_id, d.locationId, d.location_id,
  );
}

/** Record the event in integration_events (source='kleegr'); dedupe by external id. */
export async function recordWebhookEvent(
  tenantId: string | null,
  eventType: string,
  externalId: string | null,
  payload: unknown,
): Promise<{ duplicate: boolean }> {
  if (externalId) {
    const dup = await query<{ id: string }>(
      `SELECT id FROM integration_events WHERE source = 'kleegr' AND external_id = $1 LIMIT 1`,
      [externalId],
    );
    if (dup.rows[0]) return { duplicate: true };
  }
  await query(
    `INSERT INTO integration_events (id, tenant_id, source, event_type, external_id, payload, status, created_at)
      VALUES ($1,$2,'kleegr',$3,$4,$5::jsonb,'received', now())`,
    [uid("evt"), tenantId, eventType, externalId, JSON.stringify(payload ?? {})],
  );
  return { duplicate: false };
}

export interface WebhookApplyResult {
  applied: boolean;
  action: string;
  tenantId: string | null;
}

/** Apply a verified webhook event to our tenant-scoped data (idempotent). */
export async function applyWebhookEvent(eventType: string, payload: any): Promise<WebhookApplyResult> {
  const subAccountId = extractSubAccountId(payload);
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;

  switch (eventType) {
    case "app.installed":
    case "subaccount.connected": {
      if (!subAccountId) return { applied: false, action: "no_sub_account", tenantId: null };
      const loc = firstString(payload?.locationId, payload?.location_id, data?.locationId, data?.location_id);
      const name = firstString(data?.name, data?.businessName, data?.companyName);
      const t = await upsertTenantForSubAccount({ subAccountId, locationId: loc, name });
      return { applied: true, action: "tenant_connected", tenantId: t.id };
    }
    case "subaccount.disconnected": {
      if (!subAccountId) return { applied: false, action: "no_sub_account", tenantId: null };
      const t = await resolveTenantBySubAccount(subAccountId);
      if (!t) return { applied: false, action: "tenant_unknown", tenantId: null };
      await setConnectionStatus(t.id, "disconnected");
      return { applied: true, action: "tenant_disconnected", tenantId: t.id };
    }
    case "contact.created":
    case "contact.updated": {
      const t = subAccountId ? await resolveTenantBySubAccount(subAccountId) : null;
      if (!t) return { applied: false, action: "tenant_unknown", tenantId: null };
      const c = normalizeContact(data);
      if (!c) return { applied: false, action: "unparseable_contact", tenantId: t.id };
      const r = await upsertContactAsClient(t.id, c);
      return { applied: true, action: `contact_${r}`, tenantId: t.id };
    }
    case "opportunity.created":
    case "opportunity.updated": {
      const t = subAccountId ? await resolveTenantBySubAccount(subAccountId) : null;
      if (!t) return { applied: false, action: "tenant_unknown", tenantId: null };
      const o = normalizeOpportunity(data);
      if (!o) return { applied: false, action: "unparseable_opportunity", tenantId: t.id };
      const r = await upsertOpportunity(t.id, o);
      return { applied: true, action: `opportunity_${r}`, tenantId: t.id };
    }
    default:
      return { applied: false, action: "ignored", tenantId: null };
  }
}

// ---------------------------------------------------------------------------
// Status summary for the settings UI (read-only; never returns secrets)
// ---------------------------------------------------------------------------

export interface KleegrStatusSummary {
  subAccountId: string | null;
  locationId: string | null;
  connectionStatus: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  connectedUser: { email: string; role: string; kleegrRole: string | null } | null;
  counts: { importedClients: number; linkedClients: number; kleegrUsers: number };
}

export async function readKleegrStatusSummary(
  tenantId: string,
  sessionEmail?: string | null,
): Promise<KleegrStatusSummary> {
  const t = await query<any>(
    `SELECT kleegr_sub_account_id, ghl_location_id, kleegr_connection_status,
            kleegr_connected_at, kleegr_last_sync_at
       FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const row = t.rows[0] ?? {};

  const counts = await query<any>(
    `SELECT
        count(*) FILTER (WHERE kleegr_source = 'kleegr_imported')::int AS imported,
        count(*) FILTER (WHERE kleegr_source = 'kleegr_linked')::int   AS linked
       FROM clients WHERE tenant_id = $1`,
    [tenantId],
  );
  const users = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM users WHERE tenant_id = $1 AND kleegr_user_id IS NOT NULL`,
    [tenantId],
  );

  let connectedUser: KleegrStatusSummary["connectedUser"] = null;
  if (sessionEmail) {
    const u = await query<any>(
      `SELECT email, role, kleegr_role FROM users WHERE tenant_id = $1 AND lower(email) = $2 LIMIT 1`,
      [tenantId, sessionEmail.toLowerCase()],
    );
    if (u.rows[0]) connectedUser = { email: u.rows[0].email, role: u.rows[0].role, kleegrRole: u.rows[0].kleegr_role ?? null };
  }

  return {
    subAccountId: row.kleegr_sub_account_id ?? null,
    locationId: row.ghl_location_id ?? null,
    connectionStatus: row.kleegr_connection_status ?? null,
    connectedAt: row.kleegr_connected_at ? new Date(row.kleegr_connected_at).toISOString() : null,
    lastSyncAt: row.kleegr_last_sync_at ? new Date(row.kleegr_last_sync_at).toISOString() : null,
    connectedUser,
    counts: {
      importedClients: Number(counts.rows[0]?.imported ?? 0),
      linkedClients: Number(counts.rows[0]?.linked ?? 0),
      kleegrUsers: Number(users.rows[0]?.n ?? 0),
    },
  };
}
