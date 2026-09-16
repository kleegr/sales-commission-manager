// ============================================================================
// LineItemsEditor — product line items for a client document (Wave 3)
//
// Add rows by picking an assigned product; quantity + unit price (prefilled to
// the product price, which is the FLOOR — below-floor prices are blocked with a
// clear inline message and the server rejects them too). Shows a live total.
// GHL-native minor-unit pricing; used on proposals, quotes, invoices, etc.
// ============================================================================
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import { Button, Field, Input, Select } from "../ui";
import { DecimalInput } from "../TrackerForm";
import { displayMinor } from "../../lib/exact-commission";
import type { DocumentLineItem } from "../../types";

export interface CatalogProduct {
  id: string;
  name: string;
  price_minor: string;
  billing_kind: string;
  currency?: string;
}

const BILLING: Record<string, string> = { one_time: "One-time", recurring: "Recurring", setup: "Setup fee" };

/** Sum of qty*unitPrice across valid rows, as a minor-unit bigint string. */
export function lineItemsTotalMinor(items: DocumentLineItem[]): bigint {
  return items.reduce((n, it) => {
    try { return n + BigInt(it.qty) * BigInt(it.unitPriceMinor || "0"); } catch { return n; }
  }, 0n);
}

export function LineItemsEditor({
  items, onChange, products, currency, digits, loading,
}: {
  items: DocumentLineItem[];
  onChange: (items: DocumentLineItem[]) => void;
  products: CatalogProduct[];
  currency: string;
  digits: number;
  loading?: boolean;
}) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const money = (v: string) => displayMinor(v || "0", currency, digits);
  const set = (i: number, patch: Partial<DocumentLineItem>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const remove = (i: number) => onChange(items.filter((_, j) => j !== i));
  const pickProduct = (i: number, productId: string) => {
    const p = byId.get(productId);
    if (!p) { set(i, { productId: "" }); return; }
    // Prefill the floor price + name + billing when a product is chosen.
    set(i, { productId, name: p.name, unitPriceMinor: p.price_minor, billingKind: p.billing_kind });
  };
  const floorOf = (productId: string): bigint => { try { return BigInt(byId.get(productId)?.price_minor || "0"); } catch { return 0n; } };
  const belowFloor = (it: DocumentLineItem): boolean => { try { return !!it.productId && BigInt(it.unitPriceMinor || "0") < floorOf(it.productId); } catch { return false; } };
  const total = lineItemsTotalMinor(items);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Products & pricing</span>
        <span className="text-xs text-slate-500">Price is prefilled from the product and can only go up.</span>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading products…</p>
      ) : products.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-500 dark:border-slate-700">
          No products available yet. An admin can add products and assign them to you.
        </p>
      ) : (
        <>
          {items.length > 0 && (
            <div className="space-y-2">
              {items.map((it, i) => {
                const bad = belowFloor(it);
                return (
                  <div key={i} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-12 sm:items-end">
                      <div className="sm:col-span-6">
                        <Field label="Product">
                          <Select value={it.productId} onChange={(e) => pickProduct(i, e.target.value)}>
                            <option value="">Choose a product…</option>
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>{p.name} — {money(p.price_minor)} · {BILLING[p.billing_kind] ?? p.billing_kind}</option>
                            ))}
                          </Select>
                        </Field>
                      </div>
                      <div className="sm:col-span-2">
                        <Field label="Qty">
                          <Input type="number" min={1} value={it.qty} onChange={(e) => set(i, { qty: Math.max(1, Number(e.target.value) || 1) })} />
                        </Field>
                      </div>
                      <div className="sm:col-span-3">
                        <Field label={`Unit price (${currency})`}>
                          <DecimalInput label="Unit price" value={it.unitPriceMinor} digits={digits} onChange={(v) => set(i, { unitPriceMinor: v })} />
                        </Field>
                      </div>
                      <div className="sm:col-span-1 flex justify-end pb-1">
                        <Button variant="ghost" size="sm" type="button" aria-label="Remove line" onClick={() => remove(i)}>
                          <Trash2 className="h-4 w-4 text-rose-500" />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs">
                      {bad ? (
                        <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400">
                          <AlertTriangle className="h-3.5 w-3.5" /> Below the product floor — minimum {money(byId.get(it.productId)?.price_minor || "0")}.
                        </span>
                      ) : <span className="text-slate-400">Line total {money((BigInt(it.qty || 1) * BigInt(it.unitPriceMinor || "0")).toString())}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-between">
            <Button variant="secondary" size="sm" type="button" onClick={() => onChange([...items, { productId: "", name: "", qty: 1, unitPriceMinor: "0", billingKind: "one_time" }])}>
              <Plus className="h-4 w-4" /> Add product
            </Button>
            {items.length > 0 && (
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Total {money(total.toString())}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
