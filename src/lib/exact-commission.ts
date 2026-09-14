/** Shared by posted earnings and the simulator. Monetary inputs/outputs are decimal strings. */
export function minor(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?\d{1,28}$/.test(value)) throw new Error('Amount must be an integer string in minor currency units.');
  return BigInt(value);
}
export function decimalToMinor(value: string, digits = 2): string {
  if (!Number.isInteger(digits) || digits < 0 || digits > 3 || !/^-?\d+(\.\d+)?$/.test(value)) throw new Error('Enter a decimal amount.');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  if (fraction.length > digits) throw new Error(`This currency supports ${digits} decimal places.`);
  return ((negative ? -1n : 1n) * (BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0'))).toString();
}
export function displayMinor(value: string, currency: string, digits = 2): string {
  const n = minor(value), a = n < 0n ? -n : n, scale = 10n ** BigInt(digits);
  return `${currency} ${n < 0n ? '-' : ''}${a / scale}${digits ? '.' + (a % scale).toString().padStart(digits, '0') : ''}`;
}
/** Half away from zero; applies once per rule, then remainder distributed deterministically. */
export function ratio(n: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('Invalid denominator.');
  const v = n * numerator, sign = v < 0n ? -1n : 1n, a = v < 0n ? -v : v;
  return sign * ((a + denominator / 2n) / denominator);
}
export type Beneficiary = 'referrer' | 'owner' | 'closer' | 'parent' | 'grandparent' | `tier_${number}`;
export interface ExactRule {
  id: string; name: string; event: 'payment' | 'lead' | 'sale' | 'fixed_compensation';
  kind: 'percent' | 'fixed'; value: string; beneficiary: Beneficiary;
  base: 'gross' | 'net'; productId?: string; chargeFrom: number; chargeTo?: number;
  releaseTiming?: 'days' | 'month_end' | 'manual';
  holdDays: number; group: string; stacking: 'exclusive' | 'stack'; priority: number;
  splits?: {beneficiary: Beneficiary; bps: number}[];
  tiers?: {thresholdMinor: string; bps: number}[];
}
export interface ExactPlan { currency: string; minorDigits: number; rules: ExactRule[] }
export interface EarningsInput {
  event: ExactRule['event']; amountMinor: string; taxMinor: string; feeMinor: string;
  discountMinor: string; currency: string; productId: string; chargeNumber: number; date: string;
  beneficiaries: Partial<Record<Beneficiary, string>>;
}
export interface ExactEarning {ruleId:string; beneficiaryId:string; amountMinor:string; dueDate:string; explanation:string; inputs:EarningsInput}
export const BENEFICIARIES = ['referrer', 'owner', 'closer', 'parent', 'grandparent',...Array.from({length:8},(_,i)=>`tier_${i+3}`)];
export function validatePlan(plan: ExactPlan): void {
  if (!plan || !/^[A-Z]{3}$/.test(plan.currency) || ![0,2,3].includes(plan.minorDigits)) throw new Error('Select a currency and supported decimal precision.');
  if (!Array.isArray(plan.rules) || !plan.rules.length || plan.rules.length > 100) throw new Error('Provide 1–100 rules.');
  const ids = new Set<string>();
  for (const r of plan.rules) {
    if (!r.id || ids.has(r.id)) throw new Error('Rule IDs must be unique.'); ids.add(r.id);
    if (!r.name || !['payment','lead','sale','fixed_compensation'].includes(r.event) || !['percent','fixed'].includes(r.kind) || !BENEFICIARIES.includes(r.beneficiary) || !['gross','net'].includes(r.base) || !['exclusive','stack'].includes(r.stacking) || !r.group || !Number.isInteger(r.priority)) throw new Error('A rule has invalid qualification or stacking settings.');
    if(r.releaseTiming&&!['days','month_end','manual'].includes(r.releaseTiming))throw new Error('Choose a supported release timing.');
    const v = minor(r.value); if (v < 0n || (r.kind === 'percent' && v > 10000n)) throw new Error('Percentages must be 0–100% (basis points); fixed amounts cannot be negative.');
    if (!Number.isInteger(r.chargeFrom) || r.chargeFrom < 1 || (r.chargeTo !== undefined && (!Number.isInteger(r.chargeTo) || r.chargeTo < r.chargeFrom)) || !Number.isInteger(r.holdDays) || r.holdDays < 0 || r.holdDays > 3650) throw new Error('Invalid charge range or hold period.');
    if (r.event !== 'payment' && r.kind !== 'fixed') throw new Error('Non-payment rewards must be fixed amounts.');
    if (r.splits && (!r.splits.length || r.splits.some(s => !BENEFICIARIES.includes(s.beneficiary) || !Number.isInteger(s.bps) || s.bps <= 0) || r.splits.reduce((a,s)=>a+s.bps,0) !== 10000 || new Set(r.splits.map(s=>s.beneficiary)).size !== r.splits.length)) throw new Error('Pool splits must contain unique beneficiaries and total exactly 100%.');
    let previous = -1n;
    for (const t of r.tiers || []) {const threshold = minor(t.thresholdMinor); if (r.kind !== 'percent' || threshold <= previous || !Number.isInteger(t.bps) || t.bps < 0 || t.bps > 10000) throw new Error('Tiers must have increasing nonnegative thresholds and valid basis points.');previous=threshold;}
    for (const other of plan.rules) if (other !== r && other.group === r.group && (other.stacking !== r.stacking || (r.stacking === 'exclusive' && other.priority === r.priority))) throw new Error('A group must use one stacking policy; exclusive rules need distinct priorities.');
  }
}
export function calculateExact(plan:ExactPlan, input:EarningsInput):ExactEarning[] {
  validatePlan(plan);
  if (input.currency !== plan.currency) throw new Error('Currency does not match the plan.');
  const gross = minor(input.amountMinor), tax = minor(input.taxMinor), fee = minor(input.feeMinor), discount = minor(input.discountMinor);
  if ([gross,tax,fee,discount].some(v=>v<0n) || tax+fee>gross) throw new Error('Invalid receipt breakdown. Discounts are informational; collected gross is already after discounts.');
  if (!Number.isInteger(input.chargeNumber) || input.chargeNumber < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(Date.parse(input.date))) throw new Error('Invalid charge/date.');
  const groups = new Set<string>(), out:ExactEarning[]=[];
  const rules = [...plan.rules].sort((a,b)=>a.priority-b.priority || a.id.localeCompare(b.id));
  for (const r of rules) {
    if (r.event !== input.event || (r.productId && r.productId !== input.productId) || input.chargeNumber < r.chargeFrom || (r.chargeTo !== undefined && input.chargeNumber > r.chargeTo) || (r.stacking === 'exclusive' && groups.has(r.group))) continue;
    const base = r.base === 'gross' ? gross : gross-tax-fee;
    let rate = minor(r.value);
    for (const t of r.tiers || []) if (base >= minor(t.thresholdMinor)) rate=BigInt(t.bps);
    const pool = r.kind === 'percent' ? ratio(base,rate,10000n) : rate;
    const splits = r.splits || [{beneficiary:r.beneficiary,bps:10000}];
    if (splits.some(s=>!input.beneficiaries[s.beneficiary])) throw new Error(`Resolve ${r.name}'s beneficiaries before posting earnings.`);
    groups.add(r.group);
    const due = new Date(`${input.date}T00:00:00Z`);if(r.releaseTiming==='month_end'){due.setUTCMonth(due.getUTCMonth()+1,0);}due.setUTCDate(due.getUTCDate()+r.holdDays);if(r.releaseTiming==='manual')due.setUTCFullYear(9999,11,31);
    let allocated=0n;
    splits.forEach((s,i)=> {const amount = i===splits.length-1 ? pool-allocated : pool*BigInt(s.bps)/10000n;allocated+=amount;
      out.push({ruleId:r.id,beneficiaryId:input.beneficiaries[s.beneficiary]!,amountMinor:amount.toString(),dueDate:due.toISOString().slice(0,10),inputs:input,
        explanation:`${r.name}: ${r.kind==='percent'?`${rate/100n}${rate%100n?'.'+(rate%100n).toString().padStart(2,'0'):''}% of ${displayMinor(base.toString(),plan.currency,plan.minorDigits)}`:`fixed ${displayMinor(rate.toString(),plan.currency,plan.minorDigits)}`} = ${displayMinor(amount.toString(),plan.currency,plan.minorDigits)} after ${s.bps/100}% pool share. Earned ${input.date}; eligible ${due.toISOString().slice(0,10)}. ${r.releaseTiming==='manual'?'Requires an audited manual release.':r.releaseTiming==='month_end'?'Hold begins at month end.':''} Charge ${input.chargeNumber}. Gross is cash after discounts; net excludes supplied tax and fees. Value tiers apply to this receipt.`});});
  }
  return out;
}
/** Cumulative rounding makes many partial refunds equal one full refund. */
export function refundDelta(earning:string, receipt:string, previousRefund:string, refund:string):string {
  const paid=minor(receipt), previous=minor(previousRefund), next=previous+minor(refund);
  if(paid<=0n || previous<0n || minor(refund)<=0n || next>paid) throw new Error('Refund exceeds the remaining collected amount.');
  return (ratio(minor(earning),previous,paid)-ratio(minor(earning),next,paid)).toString();
}
export function simulateExact(plan:ExactPlan, input:EarningsInput, months:number, newCustomers:number, churnBps:number) {
  validatePlan(plan);
  if (!Number.isInteger(months)||months<1||months>60||!Number.isInteger(newCustomers)||newCustomers<0||newCustomers>100000||!Number.isInteger(churnBps)||churnBps<0||churnBps>10000) throw new Error('Use 1–60 months, whole customer counts and 0–100% churn.');
  const cohorts:{count:bigint;charge:number}[]=[];
  const result:{month:number;date:string;revenueMinor:string;commissionMinor:string;cumulativeRevenueMinor:string;cumulativeCommissionMinor:string;earnings:any[];estimated:true}[]=[];
  let cumulativeRevenue=0n,cumulativeCommission=0n;
  const start=new Date(`${input.date}T00:00:00Z`);if(!Number.isFinite(start.getTime()))throw new Error('Choose a valid scenario date.');
  for(let m=1;m<=months;m++){
    for(const c of cohorts){c.count=ratio(c.count,BigInt(10000-churnBps),10000n);c.charge++;}
    cohorts.push({count:BigInt(newCustomers)*10000n,charge:1});let revenue=0n,commission=0n;const detail:any[]=[];
    const date=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+m-1,1));date.setUTCDate(Math.min(start.getUTCDate(),new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate()));
    for(const c of cohorts){
      const periodInput={...input,date:date.toISOString().slice(0,10),chargeNumber:c.charge};revenue+=ratio(minor(input.amountMinor),c.count,10000n);
      const earned=calculateExact(plan,periodInput);if(c.charge===1)earned.push(...calculateExact(plan,{...periodInput,event:'sale'}));
      for(const e of earned){const amount=ratio(minor(e.amountMinor),c.count,10000n);commission+=amount;detail.push({...e,amountMinor:amount.toString(),estimatedCustomerUnits:c.count.toString(),customerUnitScale:10000});}
    }
    cumulativeRevenue+=revenue;cumulativeCommission+=commission;
    result.push({month:m,date:date.toISOString().slice(0,10),revenueMinor:revenue.toString(),commissionMinor:commission.toString(),cumulativeRevenueMinor:cumulativeRevenue.toString(),cumulativeCommissionMinor:cumulativeCommission.toString(),earnings:detail,estimated:true});
  }
  return result;
}
/** Structure builder: plain "layers" a campaign owner composes without knowing rule internals. Values are minor units (basis points for percentages). */
export interface Layer {id:string;type:'bonus'|'percent'|'fixed';value:string;from:number;to?:number}
export const LAYER_TYPES:Record<Layer['type'],string>={bonus:'Signup bonus (once, on first sale)',percent:'Percentage of each payment',fixed:'Flat amount per payment'};
export const formatBps=(bps:string)=>{const n=minor(bps);return `${n/100n}${n%100n?'.'+(n%100n).toString().padStart(2,'0').replace(/0$/,''):''}%`;};
const layerRange=(l:Layer)=>l.to===undefined?`month ${l.from} onward`:l.to===l.from?`month ${l.from}`:`months ${l.from}–${l.to}`;
export function layerName(l:Layer,currency:string,digits:number):string{try{return l.type==='bonus'?`Signup bonus ${displayMinor(l.value,currency,digits)}`:l.type==='percent'?`${formatBps(l.value)} of ${layerRange(l)}`:`${displayMinor(l.value,currency,digits)} per payment, ${layerRange(l)}`;}catch{return 'Commission layer';}}
const layersOverlap=(a:Layer,b:Layer)=>Math.max(a.from,b.from)<=Math.min(a.to??Infinity,b.to??Infinity);
/** Payment layers share group 'commission': exclusive when their month ranges are disjoint, otherwise every qualifying layer stacks. Signup bonuses are `sale` rules in group 'bonus'. */
export function compileLayers(layers:Layer[],{currency,minorDigits,holdDays}:{currency:string;minorDigits:number;holdDays:number}):ExactPlan{
  const payment=layers.filter(l=>l.type!=='bonus'),bonus=layers.filter(l=>l.type==='bonus'),common={beneficiary:'referrer' as const,base:'gross' as const,holdDays};
  const stacking:ExactRule['stacking']=payment.some((a,i)=>payment.some((b,j)=>j>i&&layersOverlap(a,b)))?'stack':'exclusive';
  const rules:ExactRule[]=layers.map((l,i)=>l.type==='bonus'?{id:l.id,name:layerName(l,currency,minorDigits),event:'sale' as const,kind:'fixed' as const,value:l.value,...common,chargeFrom:1,group:'bonus',stacking:bonus.length>1?'stack' as const:'exclusive' as const,priority:i+1}
    :{id:l.id,name:layerName(l,currency,minorDigits),event:'payment' as const,kind:l.type,value:l.value,...common,chargeFrom:l.from,...(l.to!==undefined?{chargeTo:l.to}:{}),group:'commission',stacking,priority:i+1});
  return {currency,minorDigits,rules};
}
/** Inverse of compileLayers when the plan only uses builder-shaped rules; null means "open in advanced rules". Group names are free, but the stacking policy must match what the builder would produce so nothing changes meaning silently. */
export function decompileLayers(plan:ExactPlan|null|undefined):{layers:Layer[];holdDays:number}|null{
  if(!plan||!Array.isArray(plan.rules)||!plan.rules.length)return null;
  const holdDays=plan.rules[0].holdDays,layers:Layer[]=[],groups={payment:new Set<string>(),sale:new Set<string>()};
  for(const r of plan.rules){
    if(r.beneficiary!=='referrer'||r.base!=='gross'||r.productId||r.splits?.length||r.tiers?.length||(r.releaseTiming&&r.releaseTiming!=='days')||r.holdDays!==holdDays)return null;
    if(r.event==='sale'&&r.kind==='fixed'){groups.sale.add(r.group);layers.push({id:r.id,type:'bonus',value:r.value,from:1});}
    else if(r.event==='payment'){groups.payment.add(r.group);layers.push({id:r.id,type:r.kind,value:r.value,from:r.chargeFrom,...(r.chargeTo!==undefined?{to:r.chargeTo}:{})});}
    else return null;
  }
  if(groups.payment.size>1||groups.sale.size>1||[...groups.sale].some(g=>groups.payment.has(g)))return null;
  const again=compileLayers(layers,{currency:plan.currency,minorDigits:plan.minorDigits,holdDays});
  return again.rules.every(r=>r.stacking===plan.rules.find(p=>p.id===r.id)!.stacking)?{layers,holdDays}:null;
}
export function layerPresets(digits:number,rateBps:string):Record<string,{label:string;layers:Layer[]}>{
  const unit=(n:number)=>(BigInt(n)*10n**BigInt(digits)).toString(),id=()=>crypto.randomUUID();
  return {tiered:{label:'Signup bonus + tiered residuals',layers:[{id:id(),type:'bonus',value:unit(500),from:1},{id:id(),type:'percent',value:'2000',from:1,to:1},{id:id(),type:'percent',value:'3000',from:2,to:5},{id:id(),type:'percent',value:'4000',from:6,to:12}]},
    flat:{label:'Flat % forever',layers:[{id:id(),type:'percent',value:rateBps,from:1}]},
    setup:{label:'Setup fee + recurring %',layers:[{id:id(),type:'fixed',value:unit(100),from:1,to:1},{id:id(),type:'percent',value:rateBps,from:1}]}};
}
/** Keeps exclusive rules in a group on distinct priorities (first occurrence wins its number; later duplicates move after the group's highest). */
export function renumberPriorities(rules:ExactRule[]):ExactRule[]{
  const used=new Map<string,Set<number>>();
  return rules.map(r=>{if(r.stacking!=='exclusive')return Number.isInteger(r.priority)?r:{...r,priority:1};const s=used.get(r.group)||new Set<number>();used.set(r.group,s);let p=Number.isInteger(r.priority)?r.priority:1;if(s.has(p))p=Math.max(...s)+1;s.add(p);return p===r.priority?r:{...r,priority:p};});
}
/** Per-rule hints when two exclusive rules in one group can both qualify for the same charge; only the lower priority number is paid there. */
export function overlapHints(rules:ExactRule[]):Record<number,string>{
  const out:Record<number,string>={};
  rules.forEach((a,i)=>rules.forEach((b,j)=>{if(j<=i||a.group!==b.group||a.stacking!=='exclusive'||b.stacking!=='exclusive'||a.event!==b.event||(a.productId||'')!==(b.productId||''))return;
    const from=Math.max(a.chargeFrom,b.chargeFrom),to=Math.min(a.chargeTo??Infinity,b.chargeTo??Infinity);if(from>to)return;
    const span=to===Infinity?`month ${from} onward`:from===to?`month ${from}`:`months ${from}–${to}`,winner=a.priority<=b.priority?i:j;
    for(const [k,other] of [[i,j],[j,i]]){const note=`Overlaps rule ${other+1} in ${span}; only rule ${winner+1} (priority ${rules[winner].priority}) pays there. Use stacking "add every qualifying rule" to pay both.`;out[k]=out[k]?`${out[k]} ${note}`:note;}}));
  return out;
}
/** One client paying `amountMinor` every month. A zero-churn forecast that adds one customer per month has, in month m, exactly one customer on each charge 1..m, so its month-m total is that single client's cumulative earnings through charge m (customer units are whole, so no rounding). */
export function clientSchedule(plan:ExactPlan,amountMinor:string,currency:string,date:string,months=12){
  const input:EarningsInput={event:'payment',amountMinor,taxMinor:'0',feeMinor:'0',discountMinor:'0',currency,productId:'',chargeNumber:1,date,beneficiaries:Object.fromEntries(BENEFICIARIES.map(b=>[b,'preview']))};
  const sim=simulateExact(plan,input,months,1,0),bonusMinor=calculateExact(plan,{...input,event:'sale'}).reduce((n,e)=>n+minor(e.amountMinor),0n).toString();
  return {bonusMinor,totalMinor:sim[months-1].commissionMinor,rows:sim.map((m,i)=>({month:m.month,paymentMinor:amountMinor,commissionMinor:(minor(m.commissionMinor)-(i?minor(sim[i-1].commissionMinor):0n)).toString(),cumulativeMinor:m.commissionMinor}))};
}
