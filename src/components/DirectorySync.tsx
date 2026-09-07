import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useApp } from '../store/AppContext';
import { useAuth } from '../store/AuthContext';
import { Button } from './ui';

interface SyncStatus {
  configured?: boolean; connected?: boolean; ok?: boolean;
  lastAttemptAt?: string; lastSuccessAt?: string; message?: string;
  team?: { count: number; error?: string }; clients?: { count: number; error?: string };
}

export function DirectorySync({ resource }: { resource: 'team' | 'clients' }) {
  const { reload, tenant } = useApp();
  const { user } = useAuth();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const allowed = user?.role === 'owner' || user?.role === 'admin';
  const sync = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/kleegr/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await res.json();
      setStatus(body);
      await reload();
      if (!res.ok) setError(body.message || 'The connection could not be refreshed.');
    } catch { setError('The connection could not be reached. Please retry.'); }
    finally { setBusy(false); }
  }, [reload]);

  useEffect(() => {
    if (!allowed) return;
    let active = true;
    void (async () => {
      try {
        const res = await fetch('/api/kleegr/sync', { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error();
        const body: SyncStatus = await res.json();
        if (!active) return;
        setStatus(body);
        if (body.configured && body.connected && (!body.lastAttemptAt || Date.now() - Date.parse(body.lastAttemptAt) > 300000)) await sync();
      } catch { if (active) setError('Connection status is unavailable. Please retry.'); }
    })();
    return () => { active = false; };
  }, [allowed, sync]);

  if (!allowed) return null;
  const issue = error || status?.[resource]?.error;
  const message = issue || (!status ? 'Checking the GoHighLevel connection…'
    : !status.configured ? 'The Smart Productivity token connection needs to be configured.'
    : !status.connected ? 'Open this app from your Smart Productivity sub-account to connect its data.'
    : status[resource] && !status[resource]?.error ? `${status[resource]?.count} ${resource === 'team' ? 'GoHighLevel users' : 'GoHighLevel contacts'} synced for ${tenant}.`
    : 'Ready to sync data from this sub-account.');
  return <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900" aria-live="polite">
    <div className="flex items-start gap-2 text-sm">
      {issue ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />}
      <div><p className={issue ? 'text-amber-700 dark:text-amber-300' : 'text-slate-600 dark:text-slate-300'}>{busy ? 'Syncing this sub-account’s Team and Clients…' : message}</p>
        {status?.lastSuccessAt && <p className="mt-1 text-xs text-slate-400">Last complete sync: {new Date(status.lastSuccessAt).toLocaleString()}</p>}</div>
    </div>
    <Button variant="secondary" disabled={busy} onClick={() => void sync()}><RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />{busy ? 'Syncing…' : 'Sync from GoHighLevel'}</Button>
  </div>;
}
