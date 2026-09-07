import type { VercelRequest, VercelResponse } from '@vercel/node';
import { hasDb } from '../_lib/db.js';
import { ensureSchema } from '../_lib/repository.js';
import { getSessionUser, isAdminRole } from '../_lib/auth.js';
import { csrfOk } from '../_lib/http.js';
import { DirectoryError } from '../_lib/ghl-directory.js';
import { getDirectoryStatus, syncDirectory } from '../_lib/directory-sync.js';

export const config = { maxDuration: 120 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!hasDb()) return res.status(503).json({ error: 'database_not_configured' });
  try {
    await ensureSchema();
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if (!isAdminRole(user.role)) return res.status(403).json({ error: 'forbidden' });
    // The location comes only from the session's verified tenant mapping.
    if (req.method === 'GET') return res.status(200).json(await getDirectoryStatus(user.tenantId));
    if (!csrfOk(req)) return res.status(403).json({ error: 'csrf_check_failed' });
    const summary = await syncDirectory(user.tenantId);
    return res.status(summary.ok ? 200 : 502).json(summary);
  } catch (e) {
    if (e instanceof DirectoryError) return res.status(e.status).json({ ok: false, error: e.code, message: e.message });
    console.error('[scm:directory] Sync failed');
    return res.status(500).json({ ok: false, error: 'sync_failed', message: 'The data could not be refreshed. Please retry.' });
  }
}
