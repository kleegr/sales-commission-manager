import {createHmac,timingSafeEqual} from 'node:crypto';
import type {SessionUser} from './auth.js';
import {admin,audit,id,required,TrackerError,type Database,type SQL} from './tracker-common.js';
import {operationsReady} from './operations.js';

export function verifyStripeSignature(raw:string,header:string,secret:string,now=Date.now()){
 if(!secret)throw new TrackerError('stripe_not_configured','Stripe event signing is not configured.',503);
 const parts=header.split(',').map(p=>p.split('='));const timestamp=parts.find(p=>p[0]==='t')?.[1];
 if(!timestamp||!/^\d+$/.test(timestamp)||Math.abs(now/1000-Number(timestamp))>300)throw new TrackerError('invalid_signature','Invalid or expired event signature.',401);
 const expected=createHmac('sha256',secret).update(`${timestamp}.${raw}`).digest();
 if(!parts.filter(p=>p[0]==='v1'&&/^[a-f0-9]{64}$/.test(p[1]||'')).some(p=>timingSafeEqual(expected,Buffer.from(p[1],'hex'))))throw new TrackerError('invalid_signature','Invalid event signature.',401);
}
/** Preserve only operational fields. Never store card objects or webhook credentials. */
export async function captureStripe(db:SQL,event:any){
 await operationsReady(db);const account=event.account||process.env.TRACKER_STRIPE_ACCOUNT_ID;
 if(!account)throw new TrackerError('account_unconfigured','Bind the Stripe account before receiving events.',503);
 const configs=(await db.query('SELECT tenant_id FROM tracker_provider_config WHERE stripe_account_id=$1',[account])).rows;
 if(configs.length!==1)throw new TrackerError('account_unconfigured','Stripe account must belong to exactly one configured workspace.',409);
 const tenantId=configs[0].tenant_id,object=event.data?.object;if(!object||typeof event.livemode!=='boolean')throw new TrackerError('invalid_event','Malformed Stripe event.');
 const supported=['charge.succeeded','refund.created','refund.updated','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'];
 if(!supported.includes(event.type))return{received:true,ignored:true};
 const eventId=required(event.id,'Stripe event ID',180);const exists=(await db.query("SELECT id FROM tracker_inbox WHERE tenant_id=$1 AND provider='stripe' AND external_id=$2",[tenantId,eventId])).rows[0];if(exists)return{received:true,duplicate:true};
 const objectId=required(object.id,'Provider record ID',180);let payload:any,kind:string,status=event.livemode?'pending':'test';
 if(event.type.startsWith('customer.subscription.')){
  kind='subscription';payload={subscriptionId:objectId,customerId:typeof object.customer==='string'?object.customer:null,status:object.status,startedAt:object.start_date,endedAt:object.ended_at,eventTime:event.created,test:!event.livemode};
  if(event.livemode&&Number.isInteger(object.start_date)&&Number.isInteger(event.created))await db.query(`INSERT INTO tracker_subscriptions(tenant_id,provider_id,customer_id,status,started_at,ended_at,event_time) VALUES($1,$2,$3,$4,to_timestamp($5),to_timestamp($6),$7) ON CONFLICT(tenant_id,provider_id) DO UPDATE SET status=EXCLUDED.status,ended_at=EXCLUDED.ended_at,event_time=EXCLUDED.event_time WHERE tracker_subscriptions.event_time<EXCLUDED.event_time`,[tenantId,objectId,payload.customerId,String(object.status),object.start_date,object.ended_at||null,event.created]);
  status=event.livemode?'recorded':'test';
 }else{
  kind=event.type==='charge.succeeded'?'payment':'refund';
  if(kind==='payment'&&(object.paid!==true||object.status!=='succeeded'))return{received:true,ignored:true};
  if(kind==='refund'&&object.status!=='succeeded')return{received:true,ignored:true};
  if(!Number.isSafeInteger(object.amount)||object.amount<=0||!Number.isInteger(object.created))throw new TrackerError('invalid_amount','Provider amount or date is invalid.');
  payload={occurredAt:object.created,refundReference:kind==='refund'?objectId:null,test:!event.livemode,amountMinor:String(object.amount),currency:String(object.currency).toUpperCase(),date:new Date(object.created*1000).toISOString().slice(0,10),paymentReference:kind==='payment'?objectId:typeof object.charge==='string'?object.charge:'',provider:'stripe',providerAccount:account,productId:'',email:kind==='payment'?String(object.billing_details?.email||object.receipt_email||'').toLowerCase():null,customerId:typeof object.customer==='string'?object.customer:null};
  if(!payload.paymentReference)throw new TrackerError('charge_required','Refund has no canonical charge reference.');
 }
 await db.query('INSERT INTO tracker_inbox(id,tenant_id,provider,external_id,kind,payload,status) VALUES($1,$2,\'stripe\',$3,$4,$5::jsonb,$6) ON CONFLICT(tenant_id,provider,external_id) DO NOTHING',[id('stripe'),tenantId,eventId,kind,JSON.stringify(payload),status]);return{received:true,status};
}

export async function saveProviderConfig(db:SQL,u:SessionUser,b:any,fetchImpl:typeof fetch=fetch){
 admin(u);await operationsReady(db);let account:string|null=null;
 if(b.stripeAccountId){account=required(b.stripeAccountId,'Stripe account ID',100);if(!/^acct_[a-zA-Z0-9]+$/.test(account))throw new TrackerError('invalid_account','Choose a Stripe account identifier.');
  const key=process.env.STRIPE_SECRET_KEY;if(!key)throw new TrackerError('stripe_not_configured','Connect Stripe in the server environment first.',503);
  const r=await fetchImpl('https://api.stripe.com/v1/account',{headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok||((await r.json()) as any).id!==account)throw new TrackerError('stripe_account_mismatch','The configured Stripe credentials do not belong to that account.');
  const other=(await db.query('SELECT tenant_id FROM tracker_provider_config WHERE stripe_account_id=$1 AND tenant_id<>$2',[account,u.tenantId])).rows[0];if(other)throw new TrackerError('account_in_use','This Stripe account is already assigned to another workspace.');
 }
 const email=String(b.notificationEmail||'').trim().toLowerCase();if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new TrackerError('invalid_email','Enter a valid notification email.');
 await db.query(`INSERT INTO tracker_provider_config(tenant_id,stripe_account_id,notifications_enabled,notification_email) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id) DO UPDATE SET stripe_account_id=EXCLUDED.stripe_account_id,notifications_enabled=EXCLUDED.notifications_enabled,notification_email=EXCLUDED.notification_email,updated_at=now()`,[u.tenantId,account,b.notificationsEnabled===true,email||null]);await audit(db,u,'provider_config',u.tenantId,'saved',{stripeAccountId:account,notificationsEnabled:b.notificationsEnabled===true});return{ok:true};
}

/** Claim before network work; an uncertain delivery is not automatically resent after the provider's dedupe window. */
export async function sendQueuedEmail(db:Database,u:SessionUser,b:any,fetchImpl:typeof fetch=fetch){
 admin(u);await operationsReady(db);const key=process.env.RESEND_API_KEY,from=process.env.TRACKER_EMAIL_FROM;
 if(!key||!from)throw new TrackerError('email_not_configured','Configure a verified sending domain, RESEND_API_KEY and TRACKER_EMAIL_FROM first.',503);
 if(process.env.TRACKER_EMAIL_ENABLED!=='1')throw new TrackerError('email_disabled','Email sending is not activated in this environment.',409);
 const row=await db.transaction(async c=>{const r=(await c.query('SELECT * FROM tracker_email_outbox WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[u.tenantId,b.id])).rows[0];if(!r)throw new TrackerError('not_found','Queued email not found.',404);if(r.status==='sent')return r;if(r.status!=='pending')throw new TrackerError('delivery_review_required','An attempted delivery requires provider reconciliation; it cannot be sent again blindly.',409);await c.query("UPDATE tracker_email_outbox SET status='sending',attempts=attempts+1,attempted_at=now() WHERE id=$1",[r.id]);return r;});
 if(row.status==='sent')return{duplicate:true};
 try{const r=await fetchImpl('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','Idempotency-Key':`tracker-${row.id}`},body:JSON.stringify({from,to:[row.recipient],subject:row.subject,text:row.body}),redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new Error('provider_rejected');const result:any=await r.json();if(typeof result.id!=='string')throw new Error('invalid_result');
  await db.query("UPDATE tracker_email_outbox SET status='sent',provider_id=$2,sent_at=now() WHERE id=$1",[row.id,result.id]);return{sent:true};
 }catch{await db.query("UPDATE tracker_email_outbox SET status='unknown',last_error='Check the provider delivery log before retrying.' WHERE id=$1",[row.id]);throw new TrackerError('delivery_unknown','Delivery was not confirmed. Check the email provider before retrying.',502);}
}
