// ============================================================================
// DocumentPreview — a clean, client-facing rendering of a proposal/contract.
//
// This is deliberately NOT a textarea. Sections render as a real document:
// a branded cover with the business logo, typeset section headings, readable
// paragraphs, and a signature block. Four style presets (modern / classic /
// minimal / bold) change the typography + accent so the same content can match
// the business's chosen look. Contracts carry a visible "review with a
// professional" disclaimer.
// ============================================================================

import { classNames } from "../../lib/format";
import { SECTION_LABELS } from "../../lib/documents";
import type { DocumentSection, DocumentStyle, DocumentKind } from "../../types";

export interface PreviewBranding {
  businessName: string;
  logoUrl: string;
  website: string;
  companyAddress: string;
  contactEmail: string;
  contactPhone: string;
  brandTone?: string;
}

interface StyleTokens {
  page: string;
  cover: string;
  coverTitle: string;
  coverMeta: string;
  heading: string;
  rule: string;
  body: string;
  accentText: string;
}

const STYLES: Record<DocumentStyle, StyleTokens> = {
  modern: {
    page: "font-sans",
    cover: "border-b border-slate-200 pb-8 dark:border-slate-700",
    coverTitle: "text-3xl font-bold tracking-tight text-slate-900 dark:text-white",
    coverMeta: "text-sm text-slate-500",
    heading: "text-lg font-semibold text-brand-700 dark:text-brand-300",
    rule: "mt-1 h-0.5 w-10 rounded bg-brand-500",
    body: "text-[15px] leading-relaxed text-slate-700 dark:text-slate-300",
    accentText: "text-brand-700 dark:text-brand-300",
  },
  classic: {
    page: "font-serif",
    cover: "border-b-2 border-slate-300 pb-8 text-center dark:border-slate-600",
    coverTitle: "text-3xl font-semibold tracking-wide text-slate-900 dark:text-white",
    coverMeta: "text-sm italic text-slate-500",
    heading: "text-base font-semibold uppercase tracking-[0.14em] text-slate-800 dark:text-slate-200",
    rule: "mt-1 h-px w-full bg-slate-300 dark:bg-slate-600",
    body: "text-[15px] leading-7 text-slate-700 dark:text-slate-300",
    accentText: "text-slate-800 dark:text-slate-200",
  },
  minimal: {
    page: "font-sans",
    cover: "pb-10",
    coverTitle: "text-2xl font-medium tracking-tight text-slate-900 dark:text-white",
    coverMeta: "text-xs uppercase tracking-[0.18em] text-slate-400",
    heading: "text-xs font-semibold uppercase tracking-[0.18em] text-slate-400",
    rule: "",
    body: "text-[15px] leading-relaxed text-slate-600 dark:text-slate-300",
    accentText: "text-slate-900 dark:text-white",
  },
  bold: {
    page: "font-sans",
    cover: "rounded-2xl bg-brand-600 p-8 text-white",
    coverTitle: "text-3xl font-extrabold tracking-tight",
    coverMeta: "text-sm text-brand-100",
    heading: "text-xl font-extrabold tracking-tight text-slate-900 dark:text-white",
    rule: "mt-1 h-1 w-12 rounded bg-brand-500",
    body: "text-[15px] leading-relaxed text-slate-700 dark:text-slate-300",
    accentText: "text-brand-700 dark:text-brand-300",
  },
};

function Paragraphs({ text, className }: { text: string; className: string }) {
  const blocks = (text || "").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length === 0) return <p className={classNames(className, "italic text-slate-400")}>—</p>;
  return (
    <>
      {blocks.map((block, i) => (
        <p key={i} className={classNames(className, "whitespace-pre-line")}>
          {block}
        </p>
      ))}
    </>
  );
}

function SignatureBlock({ businessName }: { businessName: string }) {
  const line = (label: string, value?: string) => (
    <div className="flex-1">
      <div className="h-10 border-b border-slate-400 dark:border-slate-500" />
      <div className="mt-1 text-xs text-slate-500">
        {label}
        {value ? ` — ${value}` : ""}
      </div>
    </div>
  );
  return (
    <div className="mt-4 flex flex-col gap-6 sm:flex-row">
      {line("Provider", businessName || undefined)}
      {line("Client")}
    </div>
  );
}

export function DocumentPreview({
  kind,
  title,
  style,
  sections,
  branding,
}: {
  kind: DocumentKind;
  title: string;
  style: DocumentStyle;
  sections: DocumentSection[];
  branding?: PreviewBranding | null;
}) {
  const t = STYLES[style] ?? STYLES.modern;
  const cover = sections.find((s) => s.type === "cover");
  const rest = sections.filter((s) => s !== cover);
  const onBrandCover = style === "bold";

  return (
    <div className={classNames("mx-auto max-w-3xl", t.page)}>
      {/* Cover / header */}
      <header className={t.cover}>
        <div className={classNames("flex items-start gap-4", style === "classic" ? "flex-col items-center" : "")}>
          {branding?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={branding.logoUrl}
              alt={branding.businessName || "Logo"}
              className={classNames("h-12 w-auto rounded object-contain", onBrandCover ? "bg-white/10 p-1" : "")}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : branding?.businessName ? (
            <div
              className={classNames(
                "flex h-12 w-12 items-center justify-center rounded-lg text-lg font-bold",
                onBrandCover ? "bg-white/15 text-white" : "bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300",
              )}
            >
              {branding.businessName.slice(0, 1).toUpperCase()}
            </div>
          ) : null}
          <div className={classNames(style === "classic" ? "text-center" : "", "min-w-0")}>
            {branding?.businessName && (
              <div className={classNames("text-sm font-medium", onBrandCover ? "text-brand-100" : "text-slate-500")}>
                {branding.businessName}
              </div>
            )}
            <h1 className={t.coverTitle}>{title || (kind === "contract" ? "Service Agreement" : "Proposal")}</h1>
            {cover?.content && <div className={classNames("mt-2", onBrandCover ? "text-brand-50" : t.coverMeta)}>
              <Paragraphs text={cover.content} className={classNames(onBrandCover ? "text-brand-50" : t.coverMeta)} />
            </div>}
          </div>
        </div>
        {branding && (branding.website || branding.contactEmail || branding.contactPhone || branding.companyAddress) && (
          <div className={classNames("mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs", onBrandCover ? "text-brand-100" : "text-slate-400")}>
            {branding.website && <span>{branding.website}</span>}
            {branding.contactEmail && <span>{branding.contactEmail}</span>}
            {branding.contactPhone && <span>{branding.contactPhone}</span>}
            {branding.companyAddress && <span>{branding.companyAddress}</span>}
          </div>
        )}
      </header>

      {kind === "contract" && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Generated contracts are templates and should be reviewed by a qualified professional before real use.
        </p>
      )}

      {/* Sections */}
      <div className="mt-8 space-y-7">
        {rest.map((s) => (
          <section key={s.id}>
            <h2 className={t.heading}>{s.title || SECTION_LABELS[s.type]}</h2>
            {t.rule && <div className={t.rule} />}
            <div className="mt-3 space-y-3">
              {s.type === "signature" ? (
                <>
                  <Paragraphs text={s.content} className={t.body} />
                  <SignatureBlock businessName={branding?.businessName ?? ""} />
                </>
              ) : (
                <Paragraphs text={s.content} className={t.body} />
              )}
            </div>
          </section>
        ))}
        {rest.length === 0 && !cover && (
          <p className="text-sm italic text-slate-400">This document has no sections yet.</p>
        )}
      </div>
    </div>
  );
}
