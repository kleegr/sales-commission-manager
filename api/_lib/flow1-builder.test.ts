// FLOW 1: the structure builder compiles plain layers into an ExactPlan the engine evaluates exactly as the owner reads it.
// Run via `tsx api/_lib/flow1-builder.test.ts`. No database.
import assert from 'node:assert/strict';
import {calculateExact,clientSchedule,compileLayers,decompileLayers,layerName,layerPresets,overlapHints,renumberPriorities,simulateExact,validatePlan,type EarningsInput,type ExactRule,type Layer} from '../../src/lib/exact-commission.js';

let checks=0;function check(name:string,fn:()=>void){fn();checks++;console.log(`✓ ${name}`);}
const opts={currency:'USD',minorDigits:2,holdDays:30};
// "$500 signup bonus + 20% of Month 1 + 30% of Months 2–5 + 40% of Months 6–12"
const canonical:Layer[]=[{id:'bonus',type:'bonus',value:'50000',from:1},{id:'m1',type:'percent',value:'2000',from:1,to:1},{id:'m2-5',type:'percent',value:'3000',from:2,to:5},{id:'m6-12',type:'percent',value:'4000',from:6,to:12}];
const input=(chargeNumber:number,event:EarningsInput['event']='payment'):EarningsInput=>({event,amountMinor:'100000',taxMinor:'0',feeMinor:'0',discountMinor:'0',currency:'USD',productId:'',chargeNumber,date:'2026-01-15',beneficiaries:{referrer:'alice'}});
const total=(earnings:{amountMinor:string}[])=>earnings.reduce((n,e)=>n+BigInt(e.amountMinor),0n).toString();

try{
  const plan=compileLayers(canonical,opts);
  check('canonical layers compile to a valid plan: 3 exclusive commission rules + 1 sale bonus rule',()=>{
    validatePlan(plan);assert.equal(plan.rules.length,4);
    const commission=plan.rules.filter(r=>r.group==='commission'),bonus=plan.rules.filter(r=>r.group==='bonus');
    assert.equal(commission.length,3);assert.ok(commission.every(r=>r.event==='payment'&&r.kind==='percent'&&r.stacking==='exclusive'&&r.beneficiary==='referrer'&&r.base==='gross'&&r.holdDays===30));
    assert.deepEqual(commission.map(r=>[r.chargeFrom,r.chargeTo]),[[1,1],[2,5],[6,12]]);
    assert.deepEqual(bonus.map(r=>[r.event,r.kind,r.value,r.chargeFrom]),[['sale','fixed','50000',1]]);
    assert.deepEqual(new Set(plan.rules.map(r=>r.priority)).size,4);
    assert.deepEqual(plan.rules.map(r=>r.name),['Signup bonus USD 500.00','20% of month 1','30% of months 2–5','40% of months 6–12']);
  });
  check('month 1/2/7/13 on a $1,000 payment earn 200/300/400/0; the first sale adds the $500 bonus',()=>{
    assert.equal(total(calculateExact(plan,input(1))),'20000');
    assert.equal(total(calculateExact(plan,input(2))),'30000');
    assert.equal(total(calculateExact(plan,input(5))),'30000');
    assert.equal(total(calculateExact(plan,input(6))),'40000');
    assert.equal(total(calculateExact(plan,input(7))),'40000');
    assert.equal(total(calculateExact(plan,input(12))),'40000');
    assert.equal(total(calculateExact(plan,input(13))),'0');
    assert.equal(total(calculateExact(plan,input(1,'sale'))),'50000');
    assert.equal(total(calculateExact(plan,input(2,'sale'))),'50000');// engine-level: the caller only raises `sale` on the client's first confirmed receipt
  });
  check('simulateExact: one customer, zero churn, 12 months cumulative = 500 + 200 + 4×300 + 7×400 = $4,700',()=>{
    const sim=simulateExact(plan,input(1),12,1,0);assert.equal(sim.length,12);
    assert.equal(sim[0].commissionMinor,'70000');// month 1: bonus + 20%
    assert.equal(sim[11].commissionMinor,'470000');
  });
  check('clientSchedule renders the 12-month table with bonus, monthly and cumulative amounts',()=>{
    const s=clientSchedule(plan,'100000','USD','2026-01-15',12);
    assert.equal(s.bonusMinor,'50000');assert.equal(s.totalMinor,'470000');assert.equal(s.rows.length,12);
    assert.deepEqual(s.rows.map(r=>r.commissionMinor),['70000','30000','30000','30000','30000','40000','40000','40000','40000','40000','40000','40000']);
    assert.deepEqual(s.rows.map(r=>r.cumulativeMinor),['70000','100000','130000','160000','190000','230000','270000','310000','350000','390000','430000','470000']);
    assert.ok(s.rows.every(r=>r.paymentMinor==='100000'));
    assert.deepEqual(s.rows.map(r=>r.month),Array.from({length:12},(_,i)=>i+1));
  });
  check('decompile round-trip: plan → layers → identical plan; the editor opens saved simple plans as layers',()=>{
    const simple=decompileLayers(plan);assert.ok(simple);assert.equal(simple!.holdDays,30);
    assert.deepEqual(simple!.layers,canonical);
    assert.deepEqual(compileLayers(simple!.layers,{...opts,holdDays:simple!.holdDays}),plan);
    // legacy single-rate campaign config (group/name chosen by the old wizard) still decompiles to one ongoing percentage layer
    const legacy={currency:'USD',minorDigits:2,rules:[{id:'standard',name:'Sales commission',event:'payment' as const,kind:'percent' as const,value:'1000',beneficiary:'referrer' as const,base:'gross' as const,chargeFrom:1,holdDays:14,group:'standard',stacking:'exclusive' as const,priority:1}]};
    assert.deepEqual(decompileLayers(legacy),{holdDays:14,layers:[{id:'standard',type:'percent',value:'1000',from:1}]});
  });
  check('plans the builder cannot express open in advanced mode (null)',()=>{
    const r=plan.rules[0];
    assert.equal(decompileLayers({...plan,rules:[{...r,beneficiary:'closer'}]}),null);
    assert.equal(decompileLayers({...plan,rules:[{...r,base:'net'}]}),null);
    assert.equal(decompileLayers({...plan,rules:[{...r,productId:'setup'}]}),null);
    assert.equal(decompileLayers({...plan,rules:[{...r,splits:[{beneficiary:'referrer',bps:10000}]}]}),null);
    assert.equal(decompileLayers({...plan,rules:[{...r,event:'lead',kind:'fixed'}]}),null);
    assert.equal(decompileLayers({...plan,rules:[r,{...plan.rules[1],holdDays:7}]}),null);
    // overlapping ranges deliberately kept exclusive would change meaning if shown as (stacking) layers
    assert.equal(decompileLayers({...plan,rules:[{...plan.rules[1],chargeTo:3},plan.rules[2]]}),null);
    assert.equal(decompileLayers(null),null);assert.equal(decompileLayers({currency:'USD',minorDigits:2,rules:[]}),null);
  });
  check('overlapping payment layers stack (flat fee + percentage on the same months both pay)',()=>{
    const stacked=compileLayers([{id:'fee',type:'fixed',value:'10000',from:1,to:1},{id:'pct',type:'percent',value:'1000',from:1}],opts);validatePlan(stacked);
    assert.ok(stacked.rules.every(r=>r.stacking==='stack'));
    assert.equal(total(calculateExact(stacked,input(1))),'20000');assert.equal(total(calculateExact(stacked,input(2))),'10000');
    assert.deepEqual(decompileLayers(stacked)!.layers.map(l=>l.id),['fee','pct']);
    const disjoint=compileLayers([{id:'fee',type:'fixed',value:'10000',from:1,to:1},{id:'pct',type:'percent',value:'1000',from:2}],opts);
    assert.ok(disjoint.rules.every(r=>r.stacking==='exclusive'));assert.equal(total(calculateExact(disjoint,input(1))),'10000');
  });
  check('presets are valid plans and the tiered preset equals the canonical structure',()=>{
    const presets=layerPresets(2,'1000');
    for(const [k,p] of Object.entries(presets)){const compiled=compileLayers(p.layers,opts);validatePlan(compiled);assert.ok(decompileLayers(compiled),k);}
    assert.deepEqual(presets.tiered.layers.map(l=>[l.type,l.value,l.from,l.to]),canonical.map(l=>[l.type,l.value,l.from,l.to]));
    assert.equal(total(calculateExact(compileLayers(presets.setup.layers,opts),input(1))),'20000');// $100 setup fee commission + 10% of $1,000
    assert.equal(layerPresets(0,'1000').tiered.layers[0].value,'500');// zero-decimal currency
    assert.equal(layerName({id:'x',type:'percent',value:'1250',from:3},'USD',2),'12.5% of month 3 onward');
    assert.equal(layerName({id:'x',type:'fixed',value:'2500',from:1,to:1},'USD',2),'USD 25.00 per payment, month 1');
  });
  check('renumberPriorities: deleting a middle rule then adding keeps exclusive priorities distinct, so validatePlan never fails on that',()=>{
    const rule=(id:string,priority:number,group='commission',stacking:ExactRule['stacking']='exclusive'):ExactRule=>({id,name:id,event:'payment',kind:'percent',value:'1000',beneficiary:'referrer',base:'gross',chargeFrom:1,holdDays:0,group,stacking,priority});
    // old editor: [1,2,3] → delete middle → [1,3] → add with rules.length+1 = 3 → collision
    const collided=[rule('a',1),rule('c',3),rule('new',3)];
    assert.throws(()=>validatePlan({currency:'USD',minorDigits:2,rules:collided}),/distinct priorities/);
    const fixed=renumberPriorities(collided);assert.deepEqual(fixed.map(r=>r.priority),[1,3,4]);validatePlan({currency:'USD',minorDigits:2,rules:fixed});
    assert.equal(fixed[0],collided[0]);// untouched rules keep identity
    // duplicates typed by hand are moved after the group's highest number; other groups and stacking rules are independent
    assert.deepEqual(renumberPriorities([rule('a',2),rule('b',2),rule('c',2,'bonus'),rule('d',2,'pool','stack'),rule('e',2,'pool','stack')]).map(r=>r.priority),[2,3,2,2,2]);
    assert.deepEqual(renumberPriorities([{...rule('a',1),priority:undefined as any},{...rule('b',1,'x','stack'),priority:undefined as any}]).map(r=>r.priority),[1,1]);
    assert.equal(Math.max(0,...fixed.map(r=>r.priority))+1,5);// "Add rule" uses max+1
  });
  check('overlapHints flags exclusive rules in one group that can both qualify for the same month',()=>{
    const hints=overlapHints(plan.rules);assert.deepEqual(hints,{});// canonical ranges are disjoint
    const rules=[{...plan.rules[1],chargeTo:3},plan.rules[2],plan.rules[0]];const h=overlapHints(rules);
    assert.match(h[0],/Overlaps rule 2 in months 2–3; only rule 1 \(priority 2\) pays there/);assert.match(h[1],/Overlaps rule 1/);assert.equal(h[2],undefined);
    assert.deepEqual(overlapHints([{...plan.rules[1],chargeTo:undefined},{...plan.rules[2],chargeTo:undefined}])[0]?.includes('month 2 onward'),true);
    assert.deepEqual(overlapHints(rules.map(r=>({...r,stacking:'stack' as const}))),{});
  });
  console.log(`${checks} checks passed`);
}catch(e){console.error(e);process.exit(1);}
