import { useState } from "react";
import { Coins, LogIn, Loader2 } from "lucide-react";
import { useAuth } from "../store/AuthContext";
import { Button, Field, Input } from "../components/ui";
import { ROLE_LABEL, type Role } from "../lib/roles";

const ERROR_TEXT: Record<string, string> = {
  invalid_credentials: "That email or password didn't match. Try again.",
  missing_credentials: "Enter both an email and a password.",
  tenant_required: "This email exists in more than one workspace — pick one.",
  network_error: "Couldn't reach the server. Check your connection.",
};

const DEMO_ROLES: Role[] = ["owner", "admin", "sales_manager", "salesperson", "affiliate", "partner"];
const DEMO_LOCAL: Record<Role, string> = {
  owner: "owner",
  admin: "admin",
  sales_manager: "manager",
  salesperson: "rep",
  affiliate: "affiliate",
  partner: "partner",
};

export default function Login() {
  const { login } = useAuth();
  const [tenant, setTenant] = useState("demo");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent, creds?: { email: string; password: string }) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const c = creds ?? { email, password };
    const res = await login(c.email, c.password, tenant);
    if (!res.ok) setError(res.error ?? "invalid_credentials");
    setBusy(false);
  }

  function quickLogin(role: Role) {
    const creds = { email: `${DEMO_LOCAL[role]}@${tenant}.example.com`, password: "demo1234" };
    setEmail(creds.email);
    setPassword(creds.password);
    void submit(new Event("submit") as unknown as React.FormEvent, creds);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
            <Coins className="h-6 w-6" />
          </span>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Commission Manager</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Sign in to your workspace</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <form onSubmit={(e) => submit(e)} className="space-y-4">
            <Field label="Workspace">
              <select
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                <option value="demo">Northwind Agency — Demo</option>
                <option value="acme">Acme Partners</option>
              </select>
            </Field>
            <Field label="Email">
              <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </Field>

            {error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                {ERROR_TEXT[error] ?? "Something went wrong. Please try again."}
              </p>
            )}

            <Button type="submit" disabled={busy} className="w-full">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              Sign in
            </Button>
          </form>
        </div>

        <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-white/60 p-4 dark:border-slate-700 dark:bg-slate-900/40">
          <p className="mb-2 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Demo accounts · password <span className="font-mono">demo1234</span>
          </p>
          <div className="grid grid-cols-2 gap-2">
            {DEMO_ROLES.map((role) => (
              <button
                key={role}
                type="button"
                disabled={busy}
                onClick={() => quickLogin(role)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-xs font-medium text-slate-700 transition hover:border-brand-400 hover:bg-brand-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {ROLE_LABEL[role]}
                <span className="block truncate font-mono text-[10px] text-slate-400">
                  {DEMO_LOCAL[role]}@{tenant}…
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
