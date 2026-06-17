import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Handshake, ArrowRight } from "lucide-react";
import { useApp } from "../store/AppContext";
import type { Salesperson } from "../types";
import { Button, Card, Field, Input, Textarea } from "../components/ui";
import { uid, todayISO } from "../lib/format";

interface FormState {
  name: string;
  email: string;
  phone: string;
  companyName: string;
  website: string;
  referralSource: string;
}

const empty: FormState = {
  name: "",
  email: "",
  phone: "",
  companyName: "",
  website: "",
  referralSource: "",
};

export default function AffiliateSignup() {
  const { dispatch } = useApp();
  const [form, setForm] = useState<FormState>(empty);
  const [done, setDone] = useState(false);

  const valid = form.name.trim() !== "" && form.email.trim() !== "";

  function submit() {
    if (!valid) return;
    const code = form.name.trim().split(/\s+/)[0].toUpperCase().slice(0, 8) || "AFF";
    const sp: Salesperson = {
      id: uid("sp"),
      name: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      role: "affiliate",
      referralCode: `${code}${Math.floor(Math.random() * 90 + 10)}`,
      status: "inactive",
      commissionPlanId: null,
      weeklySalary: null,
      salaryStartDate: null,
      salaryEndDate: null,
      notes: "",
      source: "affiliate_portal",
      approvalStatus: "pending",
      companyName: form.companyName.trim() || undefined,
      website: form.website.trim() || undefined,
      referralSource: form.referralSource.trim() || undefined,
      createdAt: todayISO(),
    };
    dispatch({ type: "SP_ADD", sp });
    setDone(true);
  }

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6 text-center">
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
          <Handshake className="h-6 w-6" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
          Become an affiliate
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Apply to our partner program. We'll review your application and get in touch.
        </p>
      </div>

      {done ? (
        <Card className="text-center">
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
            <CheckCircle2 className="h-7 w-7" />
          </span>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
            Application received
          </h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            Thanks, {form.name.split(/\s+/)[0]}. Your application is pending review. An admin will
            approve or decline it from the People page.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setForm(empty);
                setDone(false);
              }}
            >
              Submit another
            </Button>
            <Link to="/people">
              <Button>
                View applications <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </Card>
      ) : (
        <Card className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" required>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Jane Doe"
              />
            </Field>
            <Field label="Email" required>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="jane@example.com"
              />
            </Field>
            <Field label="Phone">
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="(555) 123-4567"
              />
            </Field>
            <Field label="Company">
              <Input
                value={form.companyName}
                onChange={(e) => setForm({ ...form, companyName: e.target.value })}
                placeholder="Acme Marketing"
              />
            </Field>
            <Field label="Website" className="sm:col-span-2">
              <Input
                value={form.website}
                onChange={(e) => setForm({ ...form, website: e.target.value })}
                placeholder="https://…"
              />
            </Field>
            <Field label="How will you promote us?" className="sm:col-span-2">
              <Textarea
                value={form.referralSource}
                onChange={(e) => setForm({ ...form, referralSource: e.target.value })}
                placeholder="Audience, channels, newsletter, etc."
              />
            </Field>
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 pt-4 dark:border-slate-800">
            <p className="text-xs text-slate-400">
              Submitting creates a pending affiliate for admin review.
            </p>
            <Button onClick={submit} disabled={!valid}>
              Submit application
            </Button>
          </div>
        </Card>
      )}

      <p className="mt-4 text-center text-xs text-slate-400">
        This is a simulated public form. In production it would live on a separate public route.
      </p>
    </div>
  );
}
