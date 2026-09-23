import {Check,Settings2} from 'lucide-react';
import {Button} from '../ui';
import {defaultProductPolicy,productQuote} from '../../lib/proposal-suite';
import {displayMinor} from '../../lib/exact-commission';
import type {DocumentLineItem} from '../../types';
import type {CatalogProduct} from './LineItems';

export function AppliedProductRules({product,item,items,products,currency,digits,onEdit,onUsePrice}:{
  product:CatalogProduct;item:DocumentLineItem;items:DocumentLineItem[];products:CatalogProduct[];
  currency:string;digits:number;onEdit?:()=>void;onUsePrice:()=>void;
}) {
  const rule=product.proposal_policy||defaultProductPolicy;
  const quote=productQuote(product,item.qty,items,products);
  const money=(value:string)=>displayMinor(value,currency,digits);
  const name=(id:string)=>products.find(p=>p.id===id)?.name||'Product unavailable in your catalog';
  const tier=[...rule.tiers].sort((a,b)=>b.from-a.from).find(t=>item.qty>=t.from);
  const present=(id:string)=>items.some(i=>i.productId===id);
  return <section className="proposal-applied-rules" aria-label={`Rules for ${product.name}`}>
    <div className="proposal-rule-heading"><strong><Settings2 size={14} aria-hidden="true"/>Product rules</strong>{onEdit&&<Button type="button" variant="ghost" size="sm" aria-label={`Edit rules for ${product.name}`} onClick={onEdit}>Edit rules</Button>}</div>
    <dl className="proposal-rule-summary">
      <div><dt>Allowed quantity</dt><dd>{rule.maxQty<1000000?`${rule.minQty}–${rule.maxQty} units`:`${rule.minQty}+ units`}</dd></div>
      <div><dt>{tier?'Volume price floor':'Price floor'}</dt><dd>{money(quote.floorMinor)} / unit{tier?` · ${tier.from}+ units`:''}</dd></div>
      {rule.requiresProductId&&<div><dt>Required product</dt><dd>{name(rule.requiresProductId)} <span className={present(rule.requiresProductId)?'proposal-rule-met':'proposal-rule-missing'}>{present(rule.requiresProductId)?'Added':'Needs to be added'}</span></dd></div>}
      {rule.includedFromProductId&&<div><dt>Included units</dt><dd>{rule.includedPerParent} free per {name(rule.includedFromProductId)}{!present(rule.includedFromProductId)&&' · Add this product to receive the included units'}</dd></div>}
    </dl>
    <p className="proposal-charge-breakdown"><Check size={14} aria-hidden="true"/>{item.qty} total − {quote.includedQty} included = <strong>{Math.max(0,item.qty-quote.includedQty)} charged</strong></p>
    {rule.tiers.length>0&&<div className="proposal-volume-tiers" aria-label="Volume price thresholds">{[...rule.tiers].sort((a,b)=>a.from-b.from).map(t=><span key={t.from} className={tier?.from===t.from?'is-applied':''}>{t.from}+ units: {money(t.unitPriceMinor)}{tier?.from===t.from?' · Current tier':''}</span>)}</div>}
    {item.unitPriceMinor!==quote.floorMinor&&<div className="proposal-rule-price"><span>Selling price: {money(item.unitPriceMinor)}. Rule price: {money(quote.floorMinor)}.</span><Button type="button" variant="secondary" size="sm" aria-label={`Use rule price for ${product.name}`} onClick={onUsePrice}>Use rule price</Button></div>}
    {!!rule.onboarding.length&&<details className="proposal-rule-tasks"><summary>{rule.onboarding.length} onboarding {rule.onboarding.length===1?'task':'tasks'} after verified payment</summary><ul>{rule.onboarding.map((task,index)=><li key={index}>{task}</li>)}</ul></details>}
  </section>;
}
