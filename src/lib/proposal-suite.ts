import type {DocumentLineItem, DocumentSection} from '../types/index.js';

export interface ProductPolicy {
  minQty: number;
  maxQty: number;
  requiresProductId: string;
  includedFromProductId: string;
  includedPerParent: number;
  tiers: {from: number; unitPriceMinor: string}[];
  onboarding: string[];
  costMinor?: string;
}
export const defaultProductPolicy: ProductPolicy = {minQty:1,maxQty:1000000,requiresProductId:'',includedFromProductId:'',includedPerParent:0,tiers:[],onboarding:[]};
export type PolicyProduct = {id:string;name:string;price_minor:string;proposal_policy?:ProductPolicy};
export function billableQty(item: Pick<DocumentLineItem,'qty'|'includedQty'>) {
  return Math.max(0,item.qty-Math.min(item.qty,Math.max(0,Number(item.includedQty)||0)));
}
export function productQuote(product:PolicyProduct,qty:number,items:DocumentLineItem[],catalog?:PolicyProduct[]) {
  const rule=product.proposal_policy||defaultProductPolicy;
  const tier=[...rule.tiers].sort((a,b)=>b.from-a.from).find(t=>qty>=t.from);
  const parentQty=items.filter(i=>i.productId===rule.includedFromProductId).reduce((n,i)=>n+i.qty,0);
  const includedQty=Math.min(qty,parentQty*rule.includedPerParent);
  const missing=rule.requiresProductId&&!items.some(i=>i.productId===rule.requiresProductId);
  const required=catalog?.find(p=>p.id===rule.requiresProductId);
  const missingMessage=required?`${product.name} requires ${required.name}. Add ${required.name} to continue.`:catalog?`${product.name} requires a product that is not available in your catalog. Ask an administrator to review its product rules.`:`${product.name} needs its prerequisite product.`;
  const error=qty<rule.minQty||qty>rule.maxQty?`${product.name}: choose ${rule.minQty}–${rule.maxQty} units.`:missing?missingMessage:'';
  return {floorMinor:tier?.unitPriceMinor||String(product.price_minor),includedQty,error};
}
/** Refresh inclusions on every basket change; catalog rules alone determine free units. */
export function configuredItems(items:DocumentLineItem[],products:PolicyProduct[],previous:DocumentLineItem[]=[],previousProducts:PolicyProduct[]=products):DocumentLineItem[] {
  return items.map(item=>{
    const p=products.find(p=>p.id===item.productId);if(!p)return item;
    const quote=productQuote(p,item.qty,items),old=previous.find(i=>i.productId===item.productId);
    const oldProduct=previousProducts.find(product=>product.id===item.productId)||p;
    const oldFloor=old?productQuote(oldProduct,old.qty,previous).floorMinor:String(p.price_minor);
    const automatic=!old||old.unitPriceMinor===oldFloor;
    return {...item,includedQty:quote.includedQty,unitPriceMinor:automatic&&(!old||item.unitPriceMinor===old.unitPriceMinor)?quote.floorMinor:item.unitPriceMinor};
  });
}
export interface ValueAssumptions {hoursPerMonth:number;hourlyValueMinor:string;adoptionPercent:number}
export function valueEstimate(input:ValueAssumptions,monthlyMinor:string) {
  const hours=Math.max(0,Math.min(100000,Number(input.hoursPerMonth)||0));
  const adoption=Math.max(0,Math.min(100,Number(input.adoptionPercent)||0));
  const rate=/^\d{1,18}$/.test(input.hourlyValueMinor)?BigInt(input.hourlyValueMinor):0n;
  const benefit=BigInt(Math.round(hours*adoption))*rate/100n;
  const monthly=/^\d+$/.test(monthlyMinor)?BigInt(monthlyMinor):0n;
  return {monthlyBenefitMinor:benefit.toString(),annualBenefitMinor:(benefit*12n).toString(),monthlyNetMinor:(benefit-monthly).toString()};
}
export interface ProposalPackage {id:string;name:string;description:string;items:DocumentLineItem[]}
export interface ProposalOptions {
  deliveryDate:string;renewalDate:string;effectiveDate:string;
  value:ValueAssumptions|null;packages:ProposalPackage[];approvalNote:string;
  followUpDate:string;handoverNotes:string;selectedPackageId?:string;
}
export const emptyProposalOptions=():ProposalOptions=>({deliveryDate:'',renewalDate:'',effectiveDate:'',value:null,packages:[],approvalNote:'',followUpDate:'',handoverNotes:''});
export interface QualityFinding {level:'warning'|'info';title:string;detail:string}
export function reviewProposal(input:{title:string;sections:DocumentSection[];items:DocumentLineItem[];options?:ProposalOptions}):QualityFinding[] {
  const out:QualityFinding[]=[];
  const add=(title:string,detail:string,level:'warning'|'info'='warning')=>out.push({level,title,detail});
  if(!input.items.length)add('No products','Add the products and quantities being offered.');
  if(!input.sections.some(s=>s.type==='scope'&&s.content.trim().length>20))add('Clarify the scope','Describe the deliverables and what is outside the agreed scope.');
  if(!input.sections.some(s=>s.type==='terms'&&s.content.trim().length>20))add('Payment terms are missing','Explain when payment is due and how changes are handled.');
  const text=input.sections.map(s=>s.content).join('\n');
  if(/\[(?:business|client|company|insert)[^\]]*\]|\{\{/i.test(text))add('Unfilled placeholders','Replace placeholders before sharing.');
  if(/\b(guarantee[ds]?|risk.free|100% success|unlimited)\b/i.test(text))add('Check strong promises','Confirm that guarantees and unlimited services match your actual offer.');
  const o=input.options;
  if(o?.effectiveDate&&o.deliveryDate&&o.deliveryDate<o.effectiveDate)add('Delivery date conflict','Delivery is earlier than the agreement’s effective date.');
  if(o?.renewalDate&&o.effectiveDate&&o.renewalDate<=o.effectiveDate)add('Renewal date conflict','Renewal should follow the effective date.');
  if(input.items.some(i=>i.billingKind==='recurring'))add('Confirm recurring billing','Recurring prices describe the agreement. Confirm the billing schedule with your payment provider.', 'info');
  if(o?.value)add('Value assumptions need review','The value estimate uses your assumptions and is not a guaranteed saving.', 'info');
  return out;
}
