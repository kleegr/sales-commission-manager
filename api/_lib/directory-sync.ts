import { createHash } from 'node:crypto';
import { query, withTransaction } from './db.js';
import { DirectoryError, directoryConfigured, resolveDirectoryTokens, fetchDirectoryUsers, fetchDirectoryContacts, type DirectoryPerson, type DirectoryContact } from './ghl-directory.js';

export interface DirectoryStatus {
  configured: boolean; connected: boolean; locationId: string | null;
  lastAttemptAt?: string; lastSuccessAt?: string; ok?: boolean;
  team?: { count: number; error?: string }; clients?: { count: number; error?: string };
  message?: string;
}
export const directoryId = (kind: string, tenantId: string, externalId: string) =>
  `${kind}_ghl_${createHash('sha256').update(JSON.stringify([tenantId, externalId])).digest('hex').slice(0, 32)}`;

export async function getDirectoryStatus(tenantId: string): Promise<DirectoryStatus> {
  const { rows } = await query<any>(`SELECT ghl_location_id, kleegr_sub_account_id, kleegr_connection_status, ghl_directory_sync FROM tenants WHERE id = $1 AND status = 'active'`, [tenantId]);
  const t = rows[0];
  return { ...(t?.ghl_directory_sync || {}), configured: directoryConfigured(),
    connected: Boolean(t?.kleegr_sub_account_id && t?.ghl_location_id && t?.kleegr_connection_status !== 'disconnected'), locationId: t?.ghl_location_id || null };
}

export async function persistTeam(tenantId: string, people: DirectoryPerson[], transaction = withTransaction): Promise<void> {
  await transaction(async c => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [tenantId]);
    const { rows } = await c.query<any>(`SELECT id, email, ghl_user_id, kleegr_user_id FROM salespeople WHERE tenant_id = $1`, [tenantId]);
    const matched = new Set<string>();
    const data = people.map(p => {
      const existing = rows.find(r => r.ghl_user_id === p.id || r.kleegr_user_id === p.id)
        || rows.find(r => !r.ghl_user_id && p.email && r.email?.toLowerCase() === p.email && !matched.has(r.id));
      const id = existing?.id || directoryId('sp', tenantId, p.id);
      matched.add(id);
      return { ...p, external_id: p.id, id };
    });
    await c.query(`INSERT INTO salespeople
        (id, tenant_id, name, email, phone, role, referral_code, status, approval_status, source, notes,
         ghl_user_id, ghl_role, ghl_synced_at, ghl_active, created_at, updated_at)
      SELECT r.id, $1, r.name, r.email, r.phone, 'salesperson', '', 'active', 'approved', 'admin', '',
             r.external_id, r.role, now(), true, now(), now()
      FROM jsonb_to_recordset($2::jsonb) AS r(id text, external_id text, name text, email text, phone text, role text)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone,
        ghl_user_id = EXCLUDED.ghl_user_id, ghl_role = EXCLUDED.ghl_role, ghl_synced_at = now(), ghl_active = true, updated_at = now()
      WHERE salespeople.tenant_id = EXCLUDED.tenant_id`, [tenantId, JSON.stringify(data)]);
    // Keep financial history and business roles intact when a user leaves GHL.
    await c.query(`UPDATE salespeople SET ghl_active = false, ghl_synced_at = now()
      WHERE tenant_id = $1 AND ghl_user_id IS NOT NULL AND NOT (ghl_user_id = ANY($2::text[]))`, [tenantId, people.map(p => p.id)]);
    await c.query(`UPDATE tenants SET data_revision = data_revision + 1 WHERE id = $1`, [tenantId]);
  });
}

export async function persistContacts(tenantId: string, contacts: DirectoryContact[], transaction = withTransaction): Promise<void> {
  await transaction(async c => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [tenantId]);
    const { rows: existing } = await c.query<any>(`SELECT id, ghl_contact_id, kleegr_contact_id FROM clients WHERE tenant_id = $1`, [tenantId]);
    const data = contacts.map(p => ({ ...p, id: existing.find(r => r.ghl_contact_id === p.id || r.kleegr_contact_id === p.id)?.id || directoryId('cl', tenantId, p.id),
      external_id: p.id, assigned_to: p.assignedTo, signup_date: p.createdAt && Number.isFinite(Date.parse(p.createdAt)) ? new Date(p.createdAt).toISOString().slice(0, 10) : '' }));
    await c.query(`INSERT INTO clients
      (id, tenant_id, salesperson_id, company_name, contact_name, email, phone, signup_date,
       setup_fee_amount, monthly_subscription_amount, status, notes, ghl_contact_id, kleegr_contact_id, kleegr_source,
       ghl_synced_at, created_at, updated_at)
      SELECT r.id, $1, (SELECT s.id FROM salespeople s WHERE s.tenant_id = $1 AND s.ghl_user_id = r.assigned_to LIMIT 1),
        r.company, r.name, r.email, r.phone, r.signup_date, 0, 0, 'active', '', r.external_id, r.external_id, 'kleegr_imported', now(), now(), now()
      FROM jsonb_to_recordset($2::jsonb) AS r(id text, external_id text, name text, company text, email text, phone text, assigned_to text, signup_date text)
      ON CONFLICT (id) DO UPDATE SET
        company_name = EXCLUDED.company_name, contact_name = EXCLUDED.contact_name, email = EXCLUDED.email, phone = EXCLUDED.phone,
        ghl_contact_id = EXCLUDED.ghl_contact_id, ghl_synced_at = now(), updated_at = now()
      WHERE clients.tenant_id = EXCLUDED.tenant_id`, [tenantId, JSON.stringify(data)]);
    await c.query(`UPDATE tenants SET data_revision = data_revision + 1 WHERE id = $1`, [tenantId]);
  });
}

export async function syncDirectory(tenantId: string): Promise<DirectoryStatus> {
  const previous = await getDirectoryStatus(tenantId);
  if (!previous.connected || !previous.locationId) throw new DirectoryError('subaccount_not_connected', 'Open Commission Manager from your Smart Productivity sub-account.', 409);
  const summary: DirectoryStatus = { ...previous, lastAttemptAt: new Date().toISOString(), ok: false, team: { count: previous.team?.count || 0 }, clients: { count: previous.clients?.count || 0 } };
  try {
    const tokens = await resolveDirectoryTokens(previous.locationId);
    try {
      const people = await fetchDirectoryUsers(previous.locationId, tokens);
      await persistTeam(tenantId, people);
      summary.team = { count: people.length };
    } catch (e) { summary.team!.error = e instanceof DirectoryError ? e.message : 'Team could not be saved. Please retry.'; }
    try {
      const contacts = await fetchDirectoryContacts(previous.locationId, tokens);
      await persistContacts(tenantId, contacts);
      summary.clients = { count: contacts.length };
    } catch (e) { summary.clients!.error = e instanceof DirectoryError ? e.message : 'Clients could not be saved. Please retry.'; }
    summary.ok = !summary.team!.error && !summary.clients!.error;
    summary.message = summary.ok ? 'Team and clients are up to date.' : 'Some data could not be refreshed. Previously saved records have been kept.';
    if (summary.ok) summary.lastSuccessAt = new Date().toISOString();
  } catch (e) {
    summary.message = e instanceof DirectoryError ? e.message : 'The connection could not be refreshed. Please retry.';
    summary.team!.error = summary.message;
    summary.clients!.error = summary.message;
  }
  await query(`UPDATE tenants SET ghl_directory_sync = $2::jsonb, kleegr_last_sync_at = CASE WHEN $3 THEN now() ELSE kleegr_last_sync_at END WHERE id = $1`, [tenantId, JSON.stringify(summary), summary.ok]);
  return summary;
}
