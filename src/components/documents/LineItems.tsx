import {configuredItems,productQuote,billableQty,type ProductPolicy} from '../../lib/proposal-suite';
// ============================================================================
// LineItemsEditor — product line items for a client document (Wave 3)
//
// Add rows by picking an assigned product; quantity + unit price (prefilled to
// the product price, which is the FLOOR — below-floor prices are blocked with a
// clear inline message and the server rejects them too). Shows a live total.
// GHL-native minor-unit pricing; used on proposals, quotes, invoices, etc.
// ============================================================================
import {useState} from 'react';
import {billingLabel} from '../../lib/proposal-pricing';
import {ProposalPricing} from './ProposalPricing';
import {SearchSelect} from './SearchSelect';
import {ProductRules} from './ProductRules';
import {AppliedProductRules} from './AppliedProductRules';
import {useAuth} from '../../store/AuthContext';
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import { Button, Field, Input } from "../ui";
import { DecimalInput } from "../TrackerForm";
import { displayMinor } from "../../lib/exact-commission";
import type { DocumentLineItem } from "../../types";

export interface CatalogProduct {
  proposal_policy?: ProductPolicy;
  id: string;
  name: string;
  price_minor: string;
  billing_kind: string;
  currency?: string;
  description?: string;
  category?: string;
  recurring_interval?: string;
  ghl_product_id?: string;
}

const BILLING: Record<string, string> = { one_time: "One-time", recurring: "Recurring", setup: "Setup fee" };

/** Sum of qty*unitPrice across valid rows, as a minor-unit bigint string. */
export function lineItemsTotalMinor(items: DocumentLineItem[]): bigint {
  return items.reduce((n, it) => {
    try { return n + BigInt(billableQty(it)) * BigInt(it.unitPriceMinor || "0"); } catch { return n; }
  }, 0n);
}

export function LineItemsEditor({
  items, onChange: commit, products, currency, digits, loading, showSummary = true, onPolicySaved,
}: {
  items: DocumentLineItem[];
  onChange: (items: DocumentLineItem[]) => void;
  products: CatalogProduct[];
  currency: string;
  digits: number;
  loading?: boolean;
  showSummary?: boolean;
  onPolicySaved?: (productId:string,policy:ProductPolicy)=>void;
}) {
  const {user}=useAuth();
  const [rulesFor,setRulesFor]=useState<CatalogProduct|null>(null);
  const canEditRules=!!onPolicySaved&&['owner','admin'].includes(user?.role||'');
  const onChange=(next:DocumentLineItem[])=>commit(configuredItems(next,products,items));
  const [search,setSearch]=useState('');
  const [category,setCategory]=useState('');
  const eligible=products.filter(p=>!p.currency||p.currency.toUpperCase()===currency.toUpperCase());
  const categories=[...new Set(eligible.map(p=>p.category?.trim()).filter((c):c is string=>!!c))].sort((a,b)=>a.localeCompare(b));
  const filtering=!!search.trim()||!!category;
  const available=eligible.filter(p=>(!category||p.category?.trim()===category)&&`${p.name} ${p.description||''} ${p.category||''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const byId = new Map(products.map((p) => [p.id, p]));
  const selectedIds = new Set(items.map(item=>item.productId));
  const requiredBy = new Map<string,string[]>();
  for (const item of items) {
    const product=byId.get(item.productId), requiredId=product?.proposal_policy?.requiresProductId;
    if (!product || !requiredId || selectedIds.has(requiredId)) continue;
    const names=requiredBy.get(requiredId)||[];
    if (!names.includes(product.name)) names.push(product.name);
    requiredBy.set(requiredId,names);
  }
  const money = (v: string) => displayMinor(v || "0", currency, digits);
  const set = (i: number, patch: Partial<DocumentLineItem>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const remove = (i: number) => onChange(items.filter((_, j) => j !== i));
  const pickProduct = (i: number, productId: string) => {
    const p = byId.get(productId);
    if (!p) { set(i, { productId: "" }); return; }
    // Prefill the floor price + name + billing when a product is chosen.
    set(i, { productId, name: p.name, qty:p.proposal_policy?.minQty||1, unitPriceMinor: p.price_minor, billingKind: p.billing_kind, description:p.description, category:p.category, recurringInterval:p.recurring_interval, currency:p.currency });
  };
  const addProduct = (p: CatalogProduct) => {
    if (selectedIds.has(p.id)) return;
    const line: DocumentLineItem = {productId:p.id,name:p.name,qty:p.proposal_policy?.minQty||1,unitPriceMinor:p.price_minor,billingKind:p.billing_kind,description:p.description,category:p.category,recurringInterval:p.recurring_interval,currency:p.currency};
    const blank=items.findIndex(it=>!it.productId);
    onChange(blank<0?[...items,line]:items.map((it,i)=>i===blank?line:it));
  };
  const floorOf = (productId: string): bigint => { try { return BigInt(byId.get(productId)?productQuote(byId.get(productId)!,items.find(i=>i.productId===productId)?.qty||1,items).floorMinor:"0"); } catch { return 0n; } };
  const belowFloor = (it: DocumentLineItem): boolean => { try { return !!it.productId && BigInt(it.unitPriceMinor || "0") < floorOf(it.productId); } catch { return false; } };


  return (
    <div className="space-y-3">
      {rulesFor&&canEditRules&&<ProductRules product={rulesFor} currency={currency} digits={digits} onClose={()=>setRulesFor(null)} onSaved={policy=>{
        const updated=products.map(product=>product.id===rulesFor.id?{...product,proposal_policy:policy}:product);
        onPolicySaved!(rulesFor.id,policy);
        commit(configuredItems(items,updated,items,products));
        setRulesFor(null);
      }}/>}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Products & pricing</span>
        <span className="text-xs text-slate-500">Configured volume prices and included units apply automatically.</span>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading products…</p>
      ) : products.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-3 text-sm text-slate-500 dark:border-slate-700">
          No products available yet. An admin can add products and assign them to you.
        </p>
      ) : (
        <>
          {requiredBy.size>0&&<section className="proposal-prerequisites" aria-label="Required products">
            <div className="proposal-prerequisites-heading"><AlertTriangle size={17} aria-hidden="true"/><div><strong>Add required products</strong><p>These products are needed for your selection. Add them below to continue.</p></div></div>
            <div className="proposal-prerequisites-list">{[...requiredBy].map(([id,names])=>{
              const required=byId.get(id), canAdd=eligible.some(p=>p.id===id);
              return <div className="proposal-prerequisite" key={id}>
                <div><strong>{required?.name||'Required product unavailable'}</strong><p>Required by {names.join(', ')}</p>
                  {required&&canAdd&&<span>{money(required.price_minor)} · {billingLabel({billingKind:required.billing_kind,recurringInterval:required.recurring_interval})}{(required.proposal_policy?.minQty||1)>1?` · Minimum ${required.proposal_policy!.minQty} units`:''}</span>}
                  {!canAdd&&<p>{required?`This product uses ${required.currency}; this proposal uses ${currency}. Ask an administrator to review the product rules.`:'This product is not available in your catalog. Ask an administrator to check its status and your product access.'}</p>}
                </div>
                {required&&canAdd&&<Button type="button" variant="secondary" size="sm" aria-label={`Add required product ${required.name}`} onClick={()=>addProduct(required)}><Plus size={14}/>Add {required.name}</Button>}
              </div>;
            })}</div>
          </section>}
          <div className={`proposal-catalog-filters ${categories.length?"has-categories":""}`}><Input aria-label="Search catalog products" placeholder="Search products…" value={search} onChange={e=>setSearch(e.target.value)}/>{categories.length>0&&<SearchSelect label="Product category" value={category} onChange={setCategory} options={[{value:'',label:'All categories'},...categories.map(c=>({value:c,label:c}))]}/>}</div>
          <div className="flex items-center justify-between gap-2 text-sm text-slate-500">
            <span role="status">{available.length} matching {available.length===1?'product':'products'}{filtering?'':' available to add'}</span>
            {filtering&&<Button type="button" variant="ghost" size="sm" onClick={()=>{setSearch('');setCategory('');}}>Clear filters</Button>}
          </div>
          {<div aria-label="Matching catalog products" className="proposal-product-catalog">
            {available.length===0?<p className="p-3 text-sm text-slate-500">No products match these filters. Try another search or clear the filters.</p>:available.map(p=><div key={p.id} className={`proposal-catalog-card${requiredBy.has(p.id)?' is-required':''}`}>
              <div className="min-w-0">{requiredBy.has(p.id)&&<span className="proposal-required-badge">Required for {requiredBy.get(p.id)!.join(', ')}</span>}<span className="proposal-catalog-category">{p.category||'Product'}</span><strong className="block break-words text-sm">{p.name}</strong><p className="proposal-catalog-description">{p.description||'No description has been added to this product yet.'}</p><span className="text-xs text-slate-500">{p.category||'Uncategorized'} · {money(p.price_minor)} · {billingLabel({billingKind:p.billing_kind,recurringInterval:p.recurring_interval})}</span></div>
              {items.some(it=>it.productId===p.id)?<div className="proposal-card-quantity"><span>Selected</span><label>Quantity<Input aria-label={`Quantity for ${p.name}`} type="number" min={p.proposal_policy?.minQty||1} max={p.proposal_policy?.maxQty||1000000} step={1} value={items.find(it=>it.productId===p.id)!.qty} onChange={e=>set(items.findIndex(it=>it.productId===p.id),{qty:Math.min(1000000,Math.max(1,Math.floor(Number(e.target.value))||1))})}/></label><Button type="button" variant="ghost" size="sm" aria-label={`Remove ${p.name}`} onClick={()=>remove(items.findIndex(it=>it.productId===p.id))}><Trash2 size={15}/></Button></div>:<Button type="button" variant="secondary" size="sm" aria-label={`Add ${p.name}`} onClick={()=>addProduct(p)}><Plus size={14}/> Add to proposal</Button>}
            </div>)}
          </div>}
          {items.length > 0 && (
            <div className="space-y-2">
              {items.map((it, i) => {
                const bad = belowFloor(it);
                const product=byId.get(it.productId), ruleError=product?productQuote(product,it.qty,items,products).error:'';
                return (
                  <div key={i} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-12 sm:items-end">
                      <div className="sm:col-span-6">
                        <Field label="Product">
                          <SearchSelect label="Product" value={it.productId} onChange={value=>pickProduct(i,value)} options={[...eligible,...products.filter(p=>p.id===it.productId&&!eligible.some(a=>a.id===p.id))].map(p=>({value:p.id,label:p.name,detail:`${money(p.price_minor)} · ${BILLING[p.billing_kind]??p.billing_kind}`}))} placeholder="Choose a product…"/>
                        </Field>
                      </div>
                      <div className="sm:col-span-2">
                        <Field label="Qty">
                          <Input type="number" min={product?.proposal_policy?.minQty||1} max={product?.proposal_policy?.maxQty||1000000} step={1} value={it.qty} onChange={(e) => set(i, { qty: Math.min(1000000, Math.max(1, Math.floor(Number(e.target.value)) || 1)) })} />
                        </Field>
                      </div>
                      <div className="sm:col-span-3">
                        <Field label={`Unit price (${currency})`}>
                          <DecimalInput key={it.productId} label="Unit price" value={it.unitPriceMinor} digits={digits} onChange={(v) => set(i, { unitPriceMinor: v })} />
                        </Field>
                      </div>
                      <div className="sm:col-span-1 flex justify-end pb-1">
                        <Button variant="ghost" size="sm" type="button" aria-label="Remove line" onClick={() => remove(i)}>
                          <Trash2 className="h-4 w-4 text-rose-500" />
                        </Button>
                      </div>
                    </div>
                    {it.productId&&<div className="proposal-product-description"><strong>{it.category||'Product'} · {billingLabel(it)}</strong><p>{it.description||'No description provided in the product catalog.'}</p></div>}
                    {product&&<AppliedProductRules product={product} item={it} items={items} products={products} currency={currency} digits={digits} onEdit={canEditRules?()=>setRulesFor(product):undefined} onUsePrice={()=>set(i,{unitPriceMinor:productQuote(product,it.qty,items).floorMinor})}/>}
                    {ruleError&&<p role="alert" className="proposal-error">{ruleError}</p>}
                    <div className="mt-1 flex items-center justify-between text-xs">
                      {bad ? (
                        <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400">
                          <AlertTriangle className="h-3.5 w-3.5" /> Below the product floor — minimum {money(floorOf(it.productId).toString())}.
                        </span>
                      ) : <span className="text-slate-400">Line total {money(lineItemsTotalMinor([it]).toString())}</span>}
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
              <span className="text-xs text-slate-500">{items.length} product rows</span>
            )}
          </div>
          {showSummary&&items.length>0&&<ProposalPricing items={items.filter(i=>i.productId)} currency={currency} digits={digits} detailed={false}/>}
        </>
      )}
    </div>
  );
}
