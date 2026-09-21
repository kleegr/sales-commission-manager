import {proposalCommissionPreview} from './proposal-commission-preview.js';
import {createHash} from 'node:crypto';
import {id,TrackerError,type SQL} from './tracker-common.js';
import type {SessionUser} from './auth.js';
import {isSelfRole,rowToDocument} from './documents-core.js';
import {validateDocumentLineItems} from './products.js';
import {emptyProposalOptions,defaultProductPolicy,reviewProposal,type ProductPolicy,type ProposalOptions} from '../../src/lib/proposal-suite.js';
import {proposalTotals} from '../../src/lib/proposal-pricing.js';

const txt=(v:unknown,max=2000)=>String(v??'').trim().slice(0,max);
const integer=(v:unknown,min:number,max:number)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)throw new TrackerError('invalid_rule',`Enter a whole number between ${min} and ${max}.`);return n;};
const money=(v:unknown)=>{const s=String(v??'0');if(!/^\d{1,18}$/.test(s))throw new TrackerError('invalid_price','Enter a valid non-negative amount.');return s;};
const date=(v:unknown)=>{if(!v)return '';const s=String(v);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw new TrackerError('invalid_date','Enter a valid date.');return s;};
export const canReview=(u:SessionUser)=>['owner','admin','sales_manager'].includes(u.role);
export const canSeeCosts=(u:SessionUser)=>['owner','admin'].includes(u.role);

export async function scopedProposal(db:SQL,u:SessionUser,documentId:string,forUpdate=false) {
  const row=(await db.query('SELECT * FROM documents WHERE tenant_id=$1 AND id=$2'+(forUpdate?' FOR UPDATE':''),[u.tenantId,documentId])).rows[0];
  if(!row)throw new TrackerError('not_found','Proposal not found.',404);
  if(isSelfRole(u.role)&&row.salesperson_id!==u.salespersonId)throw new TrackerError('not_found','Proposal not found.',404);
  if(u.role==='sales_manager'&&!(await db.query('SELECT 1 FROM salespeople WHERE tenant_id=$1 AND id=$2 AND manager_user_id=$3',[u.tenantId,row.salesperson_id,u.id])).rows.length)throw new TrackerError('not_found','Proposal not found.',404);
  return row;
}
export async function suiteEvent(db:SQL,row:any,kind:string,actor:string,detail='') {
  await db.query('INSERT INTO proposal_events(id,tenant_id,document_id,kind,actor,detail) VALUES($1,$2,$3,$4,$5,$6)',[id('pev'),row.tenant_id,row.id,kind,txt(actor,200),txt(detail)]);
}
export async function workspaceFor(db:SQL,row:any) {
  await db.query('INSERT INTO proposal_workspaces(document_id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[row.id,row.tenant_id]);
  return (await db.query('SELECT * FROM proposal_workspaces WHERE tenant_id=$1 AND document_id=$2',[row.tenant_id,row.id])).rows[0];
}
export function normalizeProductPolicy(raw:any):ProductPolicy {
  const b={...defaultProductPolicy,...raw},minQty=integer(b.minQty,1,1000000),maxQty=integer(b.maxQty,minQty,1000000);
  const tiers=(Array.isArray(b.tiers)?b.tiers:[]).slice(0,20).map((t:any)=>({from:integer(t.from,minQty,maxQty),unitPriceMinor:money(t.unitPriceMinor)})).sort((a:any,b:any)=>a.from-b.from);
  if(new Set(tiers.map((t:any)=>t.from)).size!==tiers.length)throw new TrackerError('invalid_rule','Use a different quantity for each volume price.');
  return {minQty,maxQty,requiresProductId:txt(b.requiresProductId,200),includedFromProductId:txt(b.includedFromProductId,200),includedPerParent:integer(b.includedPerParent,0,1000000),tiers,onboarding:(Array.isArray(b.onboarding)?b.onboarding:[]).slice(0,20).map((s:any)=>txt(s,300)).filter(Boolean),...(b.costMinor!==undefined&&b.costMinor!==''?{costMinor:money(b.costMinor)}:{})};
}
export async function normalizeOptions(db:SQL,u:SessionUser,row:any,raw:any):Promise<ProposalOptions> {
  const b={...emptyProposalOptions(),...raw};
  const packages=[];
  for(const p of (Array.isArray(b.packages)?b.packages:[]).slice(0,3)) {
    const validated=await validateDocumentLineItems(db,u.tenantId,{salespersonId:row.salesperson_id,enforceAssignment:isSelfRole(u.role)},p.items);
    if(!validated.items.length)throw new TrackerError('package_empty','Add products to every package.');
    packages.push({id:txt(p.id,100)||id('pkg'),name:txt(p.name,80)||'Package',description:txt(p.description,500),items:validated.items});
  }
  if(new Set(packages.map(p=>p.id)).size!==packages.length)throw new TrackerError('duplicate_package','Package identifiers must be unique.');
  return {deliveryDate:date(b.deliveryDate),renewalDate:date(b.renewalDate),effectiveDate:date(b.effectiveDate),followUpDate:date(b.followUpDate),approvalNote:txt(b.approvalNote),handoverNotes:txt(b.handoverNotes,4000),packages,value:b.value?{hoursPerMonth:integer(b.value.hoursPerMonth,0,100000),hourlyValueMinor:money(b.value.hourlyValueMinor),adoptionPercent:integer(b.value.adoptionPercent,0,100)}:null};
}
export const documentFingerprint=(row:any,options:any)=>{const {followUpDate,handoverNotes,...offer}=options||{};return createHash('sha256').update(JSON.stringify([row.title,row.sections,row.line_items,row.campaign_id,offer])).digest('hex');};
export async function approvalState(db:SQL,row:any,ws:any) {
  const policy=(await db.query('SELECT policy FROM proposal_policies WHERE tenant_id=$1',[row.tenant_id])).rows[0]?.policy||{};
  const total=proposalTotals(rowToDocument(row).lineItems).firstPayment;
  const amounts=[total,...(ws.options?.packages||[]).map((p:any)=>proposalTotals(p.items).firstPayment)];
  const reasons:string[]=[];
  if(policy.requireAll)reasons.push('All proposals need internal approval');
  if(policy.thresholdMinor&&amounts.some(a=>a>=BigInt(policy.thresholdMinor)))reasons.push('Proposal or package exceeds the approval threshold');
  if(ws.options?.approvalNote)reasons.push('An exception was requested');
  if(policy.customTerms){const standard=(await db.query("SELECT profile->>'paymentTerms' AS payment_terms FROM business_profiles WHERE tenant_id=$1",[row.tenant_id])).rows[0]?.payment_terms||'';const terms=rowToDocument(row).sections.filter(s=>s.type==='terms').map(s=>s.content.trim()).join('\n');if(terms!==standard.trim())reasons.push('Custom terms need review');}
  const current=ws.approval_hash===documentFingerprint(row,ws.options);
  return {required:reasons.length>0,reasons,status:current?ws.approval_status:'not_requested',note:ws.review_note||'',reviewedAt:ws.reviewed_at||null};
}
export async function assertShareApproved(db:SQL,row:any) {
  const ws=await workspaceFor(db,row),state=await approvalState(db,row,ws);
  if(state.required&&state.status!=='approved')throw new TrackerError('approval_required','Open the proposal workspace and request internal approval before sharing.',409);
}
export async function proposalFinance(db:SQL,u:SessionUser,row:any) {
  const items=rowToDocument(row).lineItems;
  const costs=(await db.query('SELECT product_id,policy FROM proposal_product_policies WHERE tenant_id=$1',[u.tenantId])).rows;
  let cost=0n,knownCost=items.length>0;
  for(const item of items){
    const policy=costs.find(r=>r.product_id===item.productId)?.policy;
    if(policy?.costMinor==null)knownCost=false;else cost+=BigInt(policy.costMinor)*BigInt(item.qty);
  }
  const revenue=proposalTotals(items).firstPayment;
  const estimate=await proposalCommissionPreview(db,row);
  return {revenueMinor:revenue.toString(),commissionEstimateMinor:estimate.sellerMinor,commissionSource:estimate.reason,...(canSeeCosts(u)?{totalCommissionMinor:estimate.totalMinor,costMinor:knownCost?cost.toString():null,marginMinor:knownCost&&estimate.totalMinor!==null?(revenue-cost-BigInt(estimate.totalMinor)).toString():null}: {})};
}
/** Verified receipt state is the trigger. Repeated callbacks cannot duplicate tasks. */
export async function syncProposalHandover(db:SQL,row:any) {
  if(row.status!=='signed')return;
  const paid=row.ghl_invoice_status==='paid'||(await db.query("SELECT 1 FROM payments WHERE tenant_id=$1 AND event_key=$2 AND receipt_status='confirmed' AND amount_minor>0 LIMIT 1",[row.tenant_id,`proposal:${row.id}`])).rows.length>0;
  if(!paid)return;
  const ws=await workspaceFor(db,row);
  const policies=ws.shared_snapshot?.onboardingPolicies||(await db.query('SELECT product_id,policy FROM proposal_product_policies WHERE tenant_id=$1',[row.tenant_id])).rows;
  const tasks=[{key:'kickoff',title:'Confirm scope, owner and kickoff with the client'}];
  for(const line of rowToDocument(row).lineItems)for(const [index,title] of (policies.find((p:any)=>p.product_id===line.productId)?.policy?.onboarding||[]).entries())tasks.push({key:`${line.productId}:${index}`,title:`${line.name}: ${title}`});
  let added=0;
  for(const task of tasks){const r=await db.query('INSERT INTO proposal_handover_tasks(id,tenant_id,document_id,task_key,title,owner_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,document_id,task_key) DO NOTHING RETURNING id',[id('pht'),row.tenant_id,row.id,task.key,task.title,row.salesperson_id]);added+=r.rows.length;}
  if(added)await suiteEvent(db,row,'onboarding_started','Payment verification',`${added} onboarding tasks created from the approved products.`);
}
export async function publicWorkspace(db:SQL,row:any) {
  const ws=await workspaceFor(db,row);
  const messages=(await db.query('SELECT id,author,source,message,request_change,attachment_url,created_at FROM proposal_messages WHERE tenant_id=$1 AND document_id=$2 ORDER BY created_at DESC LIMIT 500',[row.tenant_id,row.id])).rows.reverse();
  const o={...emptyProposalOptions(),...ws.options};
  return {deliveryDate:o.deliveryDate,effectiveDate:o.effectiveDate,renewalDate:o.renewalDate,value:o.value,packages:o.packages,selectedPackageId:o.selectedPackageId||'',messages};
}
export async function addProposalMessage(db:SQL,row:any,input:any,actor:string,source:'team'|'client') {
  const message=txt(input.message,4000);if(!message)throw new TrackerError('message_required','Write your question or reply.');
  let attachment=txt(input.attachmentUrl,2000);
  if(attachment){try{const url=new URL(attachment);if(url.protocol!=='https:'||url.username||url.password)throw 0;attachment=url.href;}catch{throw new TrackerError('invalid_attachment','Use an HTTPS link to a document.');}}
  const recent=(await db.query("SELECT count(*)::int n FROM proposal_messages WHERE tenant_id=$1 AND document_id=$2 AND created_at>now()-interval '1 hour'",[row.tenant_id,row.id])).rows[0];
  if(Number(recent?.n)>100)throw new TrackerError('rate_limited','Please wait before adding another message.',429);
  await db.query('INSERT INTO proposal_messages(id,tenant_id,document_id,author,source,message,request_change,attachment_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id('pmsg'),row.tenant_id,row.id,txt(actor,100)||'Client',source,message,!!input.requestChange,attachment]);
  await suiteEvent(db,row,input.requestChange?'change_requested':'message_added',actor,message.slice(0,200));
  return {ok:true};
}
export async function workspaceResponse(db:SQL,u:SessionUser,row:any) {
  const ws=await workspaceFor(db,row);await syncProposalHandover(db,row);
  const events=(await db.query('SELECT kind,actor,detail,created_at FROM proposal_events WHERE tenant_id=$1 AND document_id=$2 ORDER BY created_at DESC LIMIT 200',[u.tenantId,row.id])).rows;
  const tasks=(await db.query('SELECT * FROM proposal_handover_tasks WHERE tenant_id=$1 AND document_id=$2 ORDER BY created_at,id',[u.tenantId,row.id])).rows;
  const family=(await db.query('SELECT d.id,d.title,d.status,w.revision_kind FROM documents d JOIN proposal_workspaces w ON w.document_id=d.id WHERE d.tenant_id=$1 AND (d.id=$2 OR w.parent_id=$2) ORDER BY d.created_at',[u.tenantId,ws.parent_id||row.id])).rows;
  const original=ws.parent_id?(await db.query('SELECT * FROM documents WHERE tenant_id=$1 AND id=$2',[u.tenantId,ws.parent_id])).rows[0]:null;
  const previous=original?rowToDocument(original):null,current=rowToDocument(row);
  const comparison=previous?{title:previous.title,beforeMinor:proposalTotals(previous.lineItems).firstPayment.toString(),afterMinor:proposalTotals(current.lineItems).firstPayment.toString(),termsChanged:JSON.stringify(previous.sections)!==JSON.stringify(current.sections),products:[...new Set([...previous.lineItems,...current.lineItems].map(i=>i.productId))].map(productId=>{const before=previous.lineItems.find(i=>i.productId===productId),after=current.lineItems.find(i=>i.productId===productId);return {name:after?.name||before?.name,beforeQty:before?.qty||0,afterQty:after?.qty||0,beforePrice:before?.unitPriceMinor||'0',afterPrice:after?.unitPriceMinor||'0'};})}:null;
  const publicData=await publicWorkspace(db,row);
  return {comparison,options:{...emptyProposalOptions(),...ws.options},version:ws.version,approval:await approvalState(db,row,ws),finance:await proposalFinance(db,u,row),canReview:canReview(u),canSeeCosts:canSeeCosts(u),events,messages:publicData.messages,tasks,family,quality:reviewProposal({title:row.title,sections:rowToDocument(row).sections,items:rowToDocument(row).lineItems,options:ws.options}),status:row.status,updatedAt:row.updated_at};
}
