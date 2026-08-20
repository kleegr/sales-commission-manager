# Kleegr Shared Design System

One look across every Kleegr app — Sales Commission Manager, Ticketing, WhatsApp,
Meridian (Project Management) — so a user moving between them inside Smart
Productivity feels like they never left one product.

**Reference app:** `kleegr/sales-commission-manager`. Its UI *is* the spec; this
document and the `ds/` kit are extracted verbatim from it.

---

## The tokens

| Token | Value | Notes |
|---|---|---|
| Brand | `brand` blue ramp, `#3366ff` (500), `#1f47f5` (600) | Primary buttons, active nav, links, focus rings |
| Canvas | `slate-50` (light) / `slate-950` (dark) | Page background |
| Surface | `white` / `slate-900` | Cards, sidebars, headers |
| Border | `slate-200` / `slate-800` | Hairline dividers |
| Primary text | `slate-900` / `white` | Headings, values |
| Body text | `slate-600` / `slate-300` | Paragraphs, cells |
| Muted text | `slate-500` / `slate-400` | Labels, meta |
| Font | **Inter**, `antialiased`, `tabular-nums` for numbers | |
| Radius | `lg` controls · `xl` cards/tiles · `2xl` modals · `full` pills | |
| Shadow | `shadow-sm` cards/buttons · `shadow-2xl` modals | |
| Semantic tones | slate · blue · green · amber · violet · rose · cyan · indigo | Badges + StatCard icon chips |

### Typography scale
- Page title `h1`: `text-xl font-semibold tracking-tight sm:text-2xl`
- Metric value: `text-2xl font-semibold tracking-tight`
- Section eyebrow `h2`: `text-sm font-semibold uppercase tracking-wide text-slate-500`
- Body / table cell: `text-sm text-slate-700`
- Muted meta: `text-xs text-slate-500`
- Weights: `font-medium` (labels/nav/buttons), `font-semibold` (headings/values)

---

## Installing the tokens

### Tailwind v3 apps (e.g. SCM — Vite)
```js
// tailwind.config.js
const kleegr = require("./src/ds/tailwind-preset.cjs");
module.exports = { presets: [kleegr], content: ["./index.html", "./src/**/*.{ts,tsx}"] };
```

### Tailwind v4 apps (e.g. Ticketing — Next.js)
```css
/* app/globals.css */
@import "tailwindcss";
@import "./ds/theme.css";
```
Load Inter in the layout and expose it as `--font-inter`:
```tsx
import { Inter } from "next/font/google";
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
// <html className={inter.variable}> ... and set font-sans on <body>
```

---

## The component kit (`ds/kleegr-ui.tsx`)

Import from one place; never hand-roll these again:
```tsx
import { Button, Card, Badge, StatusBadge, StatCard, PageHeader, SectionTitle,
         EmptyState, Skeleton, Table, THead, TBody, TR, TH, TD,
         Input, Textarea, Select, Field, Modal, cn } from "@/ds/kleegr-ui";
```

| Component | Use |
|---|---|
| `Button` | `variant`: primary · secondary · ghost · subtle · danger; `size`: sm · md |
| `Card` | `padded` (default true; false for flush tables) |
| `Badge` / `StatusBadge` | Pills; `StatusBadge` maps common status strings → tone |
| `StatCard` | Metric tile with color-coded icon chip |
| `PageHeader` | Title + subtitle + actions row atop every screen |
| `SectionTitle` | Uppercase eyebrow inside cards |
| `EmptyState` | Dashed placeholder for "nothing here yet" |
| `Skeleton` | Loading placeholder |
| `Table/THead/TBody/TR/TH/TD` | Composable table primitives |
| `Input/Textarea/Select/Field` | Form controls + labelled field wrapper |
| `Modal` | Centered dialog, `width`: sm · md · lg · xl |

---

## The app shell (recipe, applied per app)

Every app wears the same chrome. Because each app owns its own router, the shell
is *restyled in place* rather than shipped as one component — match these classes:

- **Frame:** `flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-950`
- **Sidebar:** `w-64 flex-none border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900`
- **Brand mark:** a `bg-brand-600` `rounded-lg` `h-9 w-9` tile holding a white
  lucide icon, app name in `text-sm font-semibold text-slate-900`.
- **Nav section heading:** `px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400`
- **Nav item:** `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition`
  - active: `bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300`
  - idle: `text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800`
- **Top header:** `border-b border-slate-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80`
- **Main:** `mx-auto w-full max-w-7xl px-4 py-6 lg:px-8 lg:py-8`

> Replace ad-hoc `gray-*` with `slate-*`, `blue-*` gradients with flat `brand-*`,
> and `rounded-xl` controls with `rounded-lg` to converge on the reference.

---

## Files in `ds/`
- `kleegr-ui.tsx` — the component kit (react + lucide-react only)
- `tailwind-preset.cjs` — tokens for Tailwind v3
- `theme.css` — tokens for Tailwind v4
- `DESIGN_SYSTEM.md` — this document
