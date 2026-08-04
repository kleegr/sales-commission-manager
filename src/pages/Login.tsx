import { useState } from "react";
import { Coins, LogIn, Loader2 } from "lucide-react";
import { useAuth } from "../store/AuthContext";
import { Button, Field, Input } from "../components/ui";

const ERROR_TEXT: Record<string, string> = {
  invalid_credentials: "That email or password didn't match. Try again.",
  missing_credentials: "Enter both an email and a password.",
  tenant_required: "This email exists in more than one workspace — enter your workspace below.",
  too_many_attempts: "Too many attempts. Please wait a few minutes and try again.",
  network_error: "Couldn't reach the server. Check your connection.",
};

export default function Login() {
  const { login, expired } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tenant, setTenant] = useState("");
  const [needsTenant, setNeedsTenant] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await login(email, password, tenant.trim() || undefined);
    if (!res.ok) {
      if (res.error === "tenant_required") setNeedsTenant(true);
      setError(res.error ?? "invalid_credentials");
    }
    setBusy(false);
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
          {/* The server rejected the session mid-use (see sessionExpired() in
              AuthContext). Say why they are back here — landing on a bare login
              form with no explanation reads as the app having lost their work. */}
          {expired && !error && (
            <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              Your session expired. Please sign in again to continue.
            </p>
          )}

          <form onSubmit={submit} className="space-y-4">
            <Field label="Email">
              <Input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </Field>

            {needsTenant && (
              <Field label="Workspace">
                <Input
                  type="text"
                  autoComplete="off"
                  value={tenant}
                  onChange={(e) => setTenant(e.target.value)}
                  placeholder="your-workspace"
                />
              </Field>
            )}

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

        <p className="mt-6 text-center text-xs text-slate-400 dark:text-slate-500">
          Launched from Kleegr? Open Sales Commission Manager from your Kleegr sub-account to sign in
          automatically.
        </p>
      </div>
    </div>
  );
}
