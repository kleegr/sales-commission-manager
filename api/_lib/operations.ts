import {createHash,randomBytes,createCipheriv,createDecipheriv,timingSafeEqual} from 'node:crypto';
import type {SessionUser} from './auth.js';
import {admin,audit,client,dateOnly,id,lock,participant,required,TrackerError,workspace,type SQL} from './tracker-common.js';
import {safeDestination} from './tracker-attribution.js';
import {recordPayment,recordRefund} from './tracker-finance.js';
import {calculateExact,refundDelta,minor,type ExactPlan} from '../../src/lib/exact-commission.js';

export async function operationsInstalled(db:SQL){return !!(await db.query("SELECT 1 FROM schema_migrations WHERE id='0014_connected_operations'")).rows.length;}
export async function operationsReady(db:SQL){if(!await operationsInstalled(db))throw new TrackerError('migration_required','Connected operations require the reviewed database update.',503);}
export function accountantRead(u:SessionUser){if(!['owner','admin','accountant'].includes(u.role))throw new TrackerError('forbidden','Administrator or accountant access is required.',403);}
export const hashSecret=(s:string)=>createHash('sha256').update(s).digest('hex');
export function matchesSecret(value:string,hash:string){const a=Buffer.from(hashSecret(value),'hex'),b=Buffer.from(hash,'hex');return a.length===b.length&&timingSafeEqual(a,b);}
export async function createSource(db:SQL,u:SessionUser,b:any){
 admin(u);await operationsReady(db);await lock(db,u.tenantId);
 const campaign=(await db.query('SELECT * FROM campaigns WHERE tenant_id=$1 AND id=$2',[u.tenantId,b.campaignId])).rows[0];
 if(!campaign||campaign.conversion_mode!=='external')throw new TrackerError('external_campaign_required','Choose a campaign with external conversion capture.');
 if(!['funnel','website','store','form','survey','calendar'].includes(b.kind))throw new TrackerError('invalid_source','Choose the source type.');
 const url=safeDestination(b.url);if(new URL(url).origin!==new URL(campaign.destination_url).origin)throw new TrackerError('destination_mismatch','The source must use the campaign destination domain.');
 const key=id('source'),secret=randomBytes(32).toString('base64url');
 await db.query('INSERT INTO tracker_sources(id,tenant_id,campaign_id,name,kind,url,secret_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[key,u.tenantId,campaign.id,required(b.name,'Source name',100),b.kind,url,hashSecret(secret)]);
 await audit(db,u,'source',key,'created',{kind:b.kind,campaignId:campaign.id});return{id:key,secret};
}
export async function rotateSource(db:SQL,u:SessionUser,b:any){admin(u);await operationsReady(db);const secret=randomBytes(32).toString('base64url');const r=await db.query("UPDATE tracker_sources SET secret_hash=$3,status='configured',verified_at=NULL WHERE tenant_id=$1 AND id=$2 RETURNING id",[u.tenantId,b.id,hashSecret(secret)]);if(!r.rows.length)throw new TrackerError('not_found','Source not found.',404);await audit(db,u,'source',b.id,'secret_rotated',{});return{id:b.id,secret};}
/** A source secret belongs only in a server/workflow header, never a browser script. */
export async function captureSource(db:SQL,sourceId:string,secret:string,b:any){
 await operationsReady(db);const source=(await db.query('SELECT * FROM tracker_sources WHERE id=$1',[sourceId])).rows[0];
 if(!source||!matchesSecret(secret,source.secret_hash))throw new TrackerError('unauthorized','Invalid source credentials.',401);
 if(!['lead','payment','refund','verification'].includes(b.kind))throw new TrackerError('invalid_event','Supported events: lead, payment, refund, verification.');
 const eventId=required(b.eventId,'Stable event ID',180);await lock(db,source.tenant_id);
 if(Number((await db.query("SELECT count(*)::int n FROM tracker_inbox WHERE source_id=$1 AND created_at>now()-interval '1 minute'",[sourceId])).rows[0].n)>100)throw new TrackerError('rate_limited','Retry this event later.',429);
 const payload:any={kind:b.kind,test:b.test===true};
 if(b.kind!=='verification'){
   const click=(await db.query('SELECT id FROM referral_clicks WHERE tenant_id=$1 AND campaign_id=$2 AND id=$3 AND (expires_at>now() OR $4::boolean)',[source.tenant_id,source.campaign_id,b.clickId,b.kind==='refund'])).rows[0];
   if(!click)throw new TrackerError('invalid_click','Supply the unexpired referralClick value captured on the campaign page.');
   payload.clickId=click.id;payload.name=required(b.name,'Customer name',200);payload.email=required(b.email,'Email',254).toLowerCase();
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)||b.consent!==true)throw new TrackerError('invalid_contact','Valid email and recorded consent are required.');payload.consent=true;
   if(['payment','refund'].includes(b.kind)){payload.amountMinor=minor(b.amountMinor).toString();if(minor(payload.amountMinor)<=0n)throw new TrackerError('invalid_amount','Amount must be positive.');payload.currency=required(b.currency,'Currency',3);payload.date=dateOnly(b.date);payload.productId=String(b.productId||'').slice(0,200);payload.paymentReference=required(b.paymentReference,'Payment provider charge ID',150);payload.providerAccount=required(b.providerAccount,'Payment provider account',100);payload.provider=required(b.provider,'Payment provider',50);if(b.kind==='refund')payload.refundReference=required(b.refundReference,'Unique provider refund ID',150);}
 }
 const old=(await db.query('SELECT payload FROM tracker_inbox WHERE source_id=$1 AND external_id=$2',[sourceId,eventId])).rows[0];
 if(old){if(JSON.stringify(sortObject(old.payload))!==JSON.stringify(sortObject(payload)))throw new TrackerError('event_conflict','The event ID already has different content.',409);return{accepted:true,duplicate:true};}
 const key=id('event');await db.query('INSERT INTO tracker_inbox(id,tenant_id,source_id,provider,external_id,kind,payload,status) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',[key,source.tenant_id,sourceId,`source:${sourceId}`,eventId,b.kind,JSON.stringify(payload),b.kind==='verification'?'verified':b.test===true?'test':'pending']);
 if(b.kind==='verification')await db.query("UPDATE tracker_sources SET status='verified_connection',verified_at=now() WHERE id=$1",[sourceId]);
 return{accepted:true,id:key,status:b.kind==='verification'?'verified':b.test===true?'test':'pending',commissionCreated:false};
}
function sortObject(o:any):any{return o&&typeof o==='object'&&!Array.isArray(o)?Object.fromEntries(Object.keys(o).sort().map(k=>[k,sortObject(o[k])])):o;}
export async function reviewEvent(db:SQL,u:SessionUser,b:any){
 admin(u);await operationsReady(db);await lock(db,u.tenantId);const e=(await db.query('SELECT * FROM tracker_inbox WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[u.tenantId,b.id])).rows[0];
 if(!e)throw new TrackerError('not_found','Event not found.',404);if(e.status==='approved')return{duplicate:true};
 if(e.status!=='pending')throw new TrackerError('not_pending','Only pending live events can be approved. Test events cannot create financial records.');
 const reason=required(b.reason,'Review evidence',1000);if(b.reject){await db.query("UPDATE tracker_inbox SET status='rejected',reason=$3,reviewed_at=now() WHERE tenant_id=$1 AND id=$2",[u.tenantId,e.id,reason]);await audit(db,u,'source_event',e.id,'rejected',{reason});return{ok:true};}
 const p={...e.payload};if(e.provider==='stripe'&&Number.isInteger(p.occurredAt)){const w=await workspace(db,u);const parts=new Intl.DateTimeFormat('en-CA',{timeZone:w.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(p.occurredAt*1000));const part=(key:string)=>parts.find(v=>v.type===key)?.value;p.date=`${part('year')}-${part('month')}-${part('day')}`;}const lead=await client(db,u,required(b.clientId,'Matched local client'));
 if(p.email&&lead.email?.toLowerCase()!==p.email)throw new TrackerError('email_mismatch','Selected client email differs from this event; resolve the match before approval.');
 if(e.source_id&&e.kind!=='lead'){
  const evidence=(await db.query('SELECT k.* FROM referral_clicks k JOIN tracker_sources s ON s.tenant_id=k.tenant_id AND s.campaign_id=k.campaign_id WHERE k.tenant_id=$1 AND k.id=$2 AND s.id=$3',[u.tenantId,p.clickId,e.source_id])).rows[0];
  if(!evidence||lead.referrer_id!==evidence.salesperson_id||lead.campaign_id!==evidence.campaign_id)throw new TrackerError('attribution_required','Approve the matching source referral lead before its financial event.');
 }
 if(e.kind==='lead'){
  const click=(await db.query('SELECT k.* FROM referral_clicks k JOIN tracker_sources s ON s.tenant_id=k.tenant_id AND s.campaign_id=k.campaign_id WHERE k.tenant_id=$1 AND k.id=$2 AND s.id=$3',[u.tenantId,p.clickId,e.source_id])).rows[0];
  if(!click)throw new TrackerError('invalid_click','Referral evidence is not associated with this source.');
  if(lead.referrer_id&&lead.referrer_id!==click.salesperson_id)throw new TrackerError('attribution_conflict','Resolve the existing attribution in Clients before approving.');
  await participant(db,u,click.salesperson_id);
  await db.query("UPDATE clients SET referrer_id=$3,campaign_id=$4,attribution_method='referral_link',attribution_evidence=$5,attribution_at=COALESCE(attribution_at,now()),attribution_status='attributed' WHERE tenant_id=$1 AND id=$2",[u.tenantId,lead.id,click.salesperson_id,click.campaign_id,p.clickId]);
  await db.query("INSERT INTO attribution_events(id,tenant_id,client_id,kind,participant_id,method,evidence,reason,policy_version,actor_id) VALUES($1,$2,$3,'referrer',$4,'referral_link',$5,$6,1,$7)",[id('attr'),u.tenantId,lead.id,click.salesperson_id,p.clickId,reason,u.id]);
 }else if(e.kind==='payment'){
  if(b.confirmMapping!==true)throw new TrackerError('mapping_required','Confirm the provider account, charge identity, amount units and product mapping.');
  await recordPayment(db,u,{clientId:lead.id,eventKey:`provider:${p.provider}:${p.providerAccount}:${p.paymentReference}`,externalId:e.external_id,source:'ghl',date:p.date,amountMinor:p.amountMinor,currency:p.currency,status:'confirmed',productId:String(b.productId||p.productId||''),confirmUnattributed:b.confirmUnattributed===true,notes:reason});
 }else if(e.kind==='refund'){
  const original=(await db.query('SELECT id FROM payments WHERE tenant_id=$1 AND client_id=$2 AND event_key=$3',[u.tenantId,lead.id,`provider:${p.provider}:${p.providerAccount}:${p.paymentReference}`])).rows[0];
  if(!original)throw new TrackerError('original_required','Approve the original provider payment first.');
  const key=`refund:${p.provider}:${p.providerAccount}:${p.refundReference||e.external_id}`;
  const prior=(await db.query('SELECT parent_payment_id,amount_minor,currency,payment_date FROM payments WHERE tenant_id=$1 AND event_key=$2',[u.tenantId,key])).rows[0];
  if(prior){if(prior.parent_payment_id!==original.id||String(prior.amount_minor)!==(-minor(p.amountMinor)).toString()||prior.currency!==p.currency||prior.payment_date!==p.date)throw new TrackerError('refund_conflict','Provider refund identity has conflicting financial details.');}
  else await recordRefund(db,u,{paymentId:original.id,eventKey:key,amountMinor:p.amountMinor,date:p.date,reason});
 }else throw new TrackerError('unsupported_event','This event requires its dedicated provider mapping.');
 await db.query("UPDATE tracker_inbox SET status='approved',reason=$3,reviewed_at=now() WHERE tenant_id=$1 AND id=$2",[u.tenantId,e.id,reason]);await audit(db,u,'source_event',e.id,'approved',{kind:e.kind,clientId:lead.id,reason});return{ok:true};
}
export async function notificationScan(db:SQL,u:SessionUser){
 admin(u);await operationsReady(db);const conditions=[
 ['payout','Payouts need review',"SELECT id FROM payout_batches WHERE tenant_id=$1 AND status='submitted'"],
 ['sync','Sync needs attention',"SELECT id FROM sync_runs WHERE tenant_id=$1 AND status='failed'"],
 ['release','Commission is eligible for payout',"SELECT id FROM commission_ledger WHERE tenant_id=$1 AND amount_minor>0 AND status='pending' AND due_date<=CURRENT_DATE::text AND NOT EXISTS(SELECT 1 FROM payout_reservations p WHERE p.tenant_id=$1 AND p.entry_id=commission_ledger.id)"],
 ['import','Source event needs review',"SELECT id FROM tracker_inbox WHERE tenant_id=$1 AND status='pending'"]
 ];let created=0;
 for(const [category,title,sql] of conditions){for(const row of(await db.query(sql+' LIMIT 100',[u.tenantId])).rows){const r=await db.query('INSERT INTO tracker_notices(id,tenant_id,title,body,category,event_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,event_key) DO NOTHING RETURNING id',[id('notice'),u.tenantId,title,`Open ${category==='release'?'the commission ledger':category==='import'?'the source inbox':category==='sync'?'Integrations & Sync':'Payout'} to review this record. Reference: ${row.id}`,category,`${category}:${row.id}`]);created+=r.rows.length;}}
 return{created};
}
export async function queueWelcome(db:SQL,u:SessionUser,b:any){
 admin(u);await operationsReady(db);const sp=await participant(db,u,b.salespersonId);const email=required(sp.email,'Salesperson email',254);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new TrackerError('invalid_email','Set a valid salesperson email first.');
 const key=id('email');await db.query('INSERT INTO tracker_email_outbox(id,tenant_id,recipient,subject,body,event_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,event_key) DO NOTHING',[key,u.tenantId,email,'Welcome to your sales team',`Hello ${sp.name},\n\n${required(b.message,'Welcome message',3000)}\n\nYour administrator will provide your existing app login. Enrollment does not create a login.`,`welcome:${sp.id}`]);await audit(db,u,'email',sp.id,'welcome_queued',{});return{queued:true};
}
function taxKey(){const key=process.env.TRACKER_TAX_ENCRYPTION_KEY||'';if(!/^[0-9a-f]{64}$/i.test(key))throw new TrackerError('encryption_not_configured','Private tax storage requires the server encryption key.',503);return Buffer.from(key,'hex');}
export function encryptTax(raw:Buffer,context:string){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',taxKey(),iv);c.setAAD(Buffer.from(context));const encrypted=Buffer.concat([c.update(raw),c.final()]);return Buffer.concat([iv,c.getAuthTag(),encrypted]);}
export function decryptTax(raw:Buffer,context:string){const d=createDecipheriv('aes-256-gcm',taxKey(),raw.subarray(0,12));d.setAAD(Buffer.from(context));d.setAuthTag(raw.subarray(12,28));return Buffer.concat([d.update(raw.subarray(28)),d.final()]);}
export async function submitTax(db:SQL,u:SessionUser,b:any){
 await operationsReady(db);if(!['owner','admin','salesperson','affiliate','partner'].includes(u.role))throw new TrackerError('forbidden','Tax upload is restricted to the participant or administrator.',403);
 const sp=await participant(db,u,required(b.salespersonId,'Participant'));if(!['owner','admin'].includes(u.role)&&sp.id!==u.salespersonId)throw new TrackerError('forbidden','Only your own tax form can be uploaded.',403);
 if(!['W9','W8BEN','W8BENE'].includes(b.kind))throw new TrackerError('invalid_form','Choose W-9, W-8BEN or W-8BEN-E.');
 if(typeof b.content!=='string'||b.content.length>2700000||!/^[A-Za-z0-9+/]+={0,2}$/.test(b.content))throw new TrackerError('invalid_file','Upload a PDF up to 2 MB.');const raw=Buffer.from(b.content,'base64');if(raw.length>2000000||raw.subarray(0,5).toString()!=='%PDF-')throw new TrackerError('invalid_pdf','Upload a PDF up to 2 MB.');
 const key=id('tax');await db.query('INSERT INTO tracker_tax_documents(id,tenant_id,salesperson_id,kind,filename,encrypted_content,submitted_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[key,u.tenantId,sp.id,b.kind,required(b.filename,'Filename',150),encryptTax(raw,`${u.tenantId}:${key}`),u.id]);await audit(db,u,'tax_document',key,'submitted',{participantId:sp.id,kind:b.kind});return{id:key};
}
export async function reviewTax(db:SQL,u:SessionUser,b:any){admin(u);await operationsReady(db);if(!['accepted','rejected'].includes(b.status))throw new TrackerError('invalid_status','Choose accepted or rejected.');const r=await db.query('UPDATE tracker_tax_documents SET status=$3,reviewed_by=$4,review_note=$5,reviewed_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id',[u.tenantId,b.id,b.status,u.id,required(b.reason,'Review note',500)]);if(!r.rows.length)throw new TrackerError('not_found','Tax form not found.',404);await audit(db,u,'tax_document',b.id,'reviewed',{status:b.status});return{ok:true};}
export async function taxDownload(db:SQL,u:SessionUser,key:string){await operationsReady(db);const row=(await db.query('SELECT * FROM tracker_tax_documents WHERE tenant_id=$1 AND id=$2',[u.tenantId,key])).rows[0];if(!row||(!['owner','admin'].includes(u.role)&&(!u.salespersonId||row.salesperson_id!==u.salespersonId)))throw new TrackerError('not_found','Tax form not found.',404);await audit(db,u,'tax_document',key,'downloaded',{});return{filename:row.filename,content:decryptTax(Buffer.from(row.encrypted_content),`${u.tenantId}:${key}`)};}
export function testScenario(b:any){
 const amount=minor(b.amountMinor||'10000'),rate=Number(b.rateBps??1000),refund=minor(b.refundMinor||'2000');if(amount<=0n||refund<0n||refund>amount)throw new TrackerError('invalid_scenario','Use a positive payment and a refund no larger than the payment.');
 const plan:ExactPlan={currency:'USD',minorDigits:2,rules:[{id:'test',name:'Test commission',event:'payment',kind:'percent',value:String(rate),beneficiary:'referrer',base:'gross',chargeFrom:1,holdDays:30,group:'sale',stacking:'exclusive',priority:1}]};
 const earnings=calculateExact(plan,{event:'payment',amountMinor:amount.toString(),taxMinor:'0',feeMinor:'0',discountMinor:'0',currency:'USD',productId:'test',chargeNumber:1,date:'2026-01-01',beneficiaries:{referrer:'test-salesperson'}});const earned=earnings[0].amountMinor;const reversal=refund>0n?refundDelta(earned,amount.toString(),'0',refund.toString()):'0';
 return{test:true,persisted:false,moneyMoved:false,currency:'USD',paymentMinor:amount.toString(),commissionMinor:earned,refundMinor:refund.toString(),reversalMinor:reversal,remainingCommissionMinor:(minor(earned)+minor(reversal)).toString(),earnings,steps:['Test salesperson refers a customer','A simulated payment qualifies','The production calculation engine calculates commission','A 30-day hold determines eligibility','A partial refund produces a linked commission reversal'],scope:'Calculation simulation only. This does not verify GHL checkout, provider webhooks or actual transfers.'};
}
