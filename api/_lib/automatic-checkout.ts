import type {SessionUser} from './auth.js';
import {admin,audit,id,lock,TrackerError,workspace,type Database,type SQL} from './tracker-common.js';
import {gatewayPage} from './kleegr-read.js';
import {recordPayment,recordRefund} from './tracker-finance.js';
import {calculateExact,decimalToMinor,minor} from '../../src/lib/exact-commission.js';

export async function checkoutContext(db:SQL,clickId:string){
 const row=(await db.query(`SELECT k.*,c.destination_url,c.tracking_policy,c.status,c.plan_version_id,t.ghl_location_id FROM referral_clicks k JOIN campaigns c ON c.tenant_id=k.tenant_id AND c.id=k.campaign_id JOIN tenants t ON t.id=k.tenant_id WHERE k.id=$1`,[clickId])).rows[0];
 if(!row||!row.tracking_policy.automation||row.tracking_policy.automation==='off')throw new TrackerError('tracking_unavailable','Automatic tracking is not enabled for this campaign.',404);return row;
}
export async function registerCheckout(db:SQL,clickId:string,b:any){
 const c=await checkoutContext(db,clickId);if(c.status!=='active'||new Date(c.expires_at).getTime()<Date.now())throw new TrackerError('expired_referral','Referral is no longer active.');
 if(!/^[a-zA-Z0-9_-]{5,100}$/.test(String(b.orderId||''))||!/^[a-zA-Z0-9_-]{16,150}$/.test(String(b.trackingId||'')))throw new TrackerError('invalid_checkout','Provide the checkout order and tracking identifiers.');
 await lock(db,c.tenant_id);
 const key=`${c.tenant_id}:${b.orderId}`,old=(await db.query("SELECT * FROM tracker_inbox WHERE tenant_id=$1 AND provider='ghl-checkout' AND external_id=$2",[c.tenant_id,key])).rows[0];
 if(old){if(old.payload.clickId!==clickId||old.payload.trackingId!==b.trackingId)throw new TrackerError('checkout_conflict','This order already has referral evidence.',409);return{id:old.id,tenantId:c.tenant_id,status:old.status};}
 const recent=(await db.query("SELECT count(*)::int n FROM tracker_inbox WHERE tenant_id=$1 AND provider='ghl-checkout' AND payload->>'clickId'=$2",[c.tenant_id,clickId])).rows[0].n;
 if(recent>=20)throw new TrackerError('rate_limited','Too many checkout attempts for this referral.',429);
 const eventId=id('checkout');await db.query("INSERT INTO tracker_inbox(id,tenant_id,provider,external_id,kind,payload,status) VALUES($1,$2,'ghl-checkout',$3,'checkout',$4::jsonb,'awaiting_payment')",[eventId,c.tenant_id,key,JSON.stringify({clickId,orderId:b.orderId,trackingId:b.trackingId,mode:c.tracking_policy.automation})]);
 return{id:eventId,tenantId:c.tenant_id,status:'awaiting_payment'};
}
const pContactName=(c:any)=>String(c.name||[c.firstName,c.lastName].filter(Boolean).join(' ')||'Checkout customer').slice(0,200);
const asObject=(v:any)=>typeof v==='string'?JSON.parse(v):v;
const liveMode=(v:any)=>{if(![true,false,'true','false'].includes(v))throw new TrackerError('mode_required','Provider test/live mode is missing.');return v===true||v==='true';};
const dateInZone=(v:string,zone:string)=>{const p=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(v));return ['year','month','day'].map(k=>p.find(x=>x.type===k)!.value).join('-');};

/** Only provider-read evidence supplies customer, source, product, amount and payment state. */
export async function reconcileCheckout(db:Database,tenantId:string,eventId:string,reader= gatewayPage){
 const event=(await db.query("SELECT * FROM tracker_inbox WHERE tenant_id=$1 AND id=$2 AND provider='ghl-checkout'",[tenantId,eventId])).rows[0];if(!event)throw new TrackerError('not_found','Checkout not found.',404);
 const c=await checkoutContext(db,event.payload.clickId);
 const orderBody=(await reader(c.ghl_location_id,'order',0,fetch,{orderId:event.payload.orderId})).payload,order=orderBody.order||orderBody;
 const mode=event.payload.mode==='auto'?(liveMode(order.liveMode)?'live':'test'):event.payload.mode;
 const source=asObject(order.source)||{},tracking=String(order.trackingId||'');
 if(order.altId!==c.ghl_location_id||order._id!==event.payload.orderId||tracking!==event.payload.trackingId||source.id!==c.tracking_policy.source?.selection.id||liveMode(order.liveMode)!==(mode==='live'))throw new TrackerError('checkout_evidence_mismatch','The provider order does not match the campaign, tracking identifier or test/live mode.');
 const when=Date.parse(order.createdAt);if(!Number.isFinite(when)||when<new Date(c.created_at).getTime()-30000||when>new Date(c.expires_at).getTime())throw new TrackerError('checkout_outside_window','Order is outside the referral window.');
 await db.query("UPDATE tracker_inbox SET payload=jsonb_set(payload,'{mode}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2 AND payload->>'mode'='auto'",[tenantId,eventId,mode]);
 const transactions=(await reader(c.ghl_location_id,'orderPayments',0,fetch,{orderId:order._id,mode})).payload;
 if(!Array.isArray(transactions.data)||transactions.totalCount>100)throw new TrackerError('payment_review_required','Payment pagination needs review.');
 const succeeded=transactions.data.filter((p:any)=>p.status==='succeeded');if(!succeeded.length)return{status:'awaiting_payment'};
 return db.transaction(async sql=>{
  await lock(sql,tenantId);
  const actor=(await sql.query("SELECT id,name,email,role FROM users WHERE tenant_id=$1 AND role IN('owner','admin') AND status='active' ORDER BY id LIMIT 1",[tenantId])).rows[0];if(!actor)throw new TrackerError('administrator_required','An active administrator is required.');
  const u={...actor,tenantId,salespersonId:null} as SessionUser,w=await workspace(sql,u),currency=String(order.currency||'').toUpperCase(),digits=w.payout_terms?.minorDigits??2;
  if(currency!==w.currency)throw new TrackerError('currency_mismatch','Checkout currency differs from the workspace.');
  const items=asObject(order.items);if(!Array.isArray(items)||items.length!==1)throw new TrackerError('basket_review_required','Multi-product baskets require line-item allocation review before automatic posting.');
  const item=asObject(items[0]),productId=String(item.product?._id||item.productId||item.price?.product||'');
  const eligible=c.tracking_policy.source?.selection.checkout?.products||[];
  if(!eligible.some((p:any)=>p.productId===productId))throw new TrackerError('product_not_eligible','This product is not included in the selected campaign page.');
  const plan=(await sql.query('SELECT config FROM plan_versions WHERE tenant_id=$1 AND id=$2',[tenantId,c.plan_version_id])).rows[0]?.config;
  if(plan?.rules?.some((r:any)=>r.base==='net'))throw new TrackerError('fee_review_required','Net commission rules require verified fee and tax allocation before automatic posting.');
  if(!plan)throw new TrackerError('plan_required','Publish and assign the campaign commission plan.');
  const contact=asObject(order.contactSnapshot)||{},contactId=String(order.contactId||contact.id||contact._id||'');
  if(!contactId)throw new TrackerError('contact_required','The provider order has no stable customer identity.');
  const results=[];
  for(const p of succeeded){
   if(p.altId!==c.ghl_location_id||p.entityId!==order._id||liveMode(p.liveMode)!==(mode==='live')||String(p.currency).toUpperCase()!==currency||p.contactId!==contactId||!p.chargeId||!p.paymentProviderConnectedAccount||!p.paymentProviderType)throw new TrackerError('payment_evidence_mismatch','A transaction is missing matching provider identity.');
   const amount=decimalToMinor(String(p.amount),digits),date=dateInZone(p.createdAt,w.timezone);if(minor(amount)<=0n)throw new TrackerError('invalid_amount','Only positive collected payments qualify.');
   if(mode!=='live'){
    const earnings=calculateExact(plan,{event:'payment',amountMinor:amount,taxMinor:'0',feeMinor:'0',discountMinor:'0',currency,productId,chargeNumber:1,date,beneficiaries:{referrer:c.salesperson_id}});
    results.push({transactionId:p._id,amountMinor:amount,currency,commissionMinor:earnings.reduce((n,e)=>n+minor(e.amountMinor),0n).toString(),earnings});continue;
   }
   const existing=(await sql.query('SELECT * FROM clients WHERE tenant_id=$1 AND (ghl_contact_id=$2 OR kleegr_contact_id=$2)',[tenantId,contactId])).rows;
   if(existing.length>1)throw new TrackerError('ambiguous_client','Resolve duplicate customer identities before posting.');
   let lead=existing[0]; // Keep existing customer attribution; this verified order carries its own campaign/referrer.
   if(!lead){const leadId=id('lead');await sql.query("INSERT INTO clients(id,tenant_id,contact_name,email,ghl_contact_id,original_source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'ghl_checkout',now(),now())",[leadId,tenantId,p.contactName||contact.name||'Checkout customer',p.contactEmail||contact.email||'',contactId]);lead={id:leadId};}
   if(!lead.referrer_id){await sql.query("UPDATE clients SET referrer_id=$3,campaign_id=$4,attribution_method='referral_link',attribution_evidence=$5,attribution_at=now(),attribution_status='attributed' WHERE tenant_id=$1 AND id=$2",[tenantId,lead.id,c.salesperson_id,c.campaign_id,event.payload.clickId]);await audit(sql,u,'client',lead.id,'checkout_attributed',{clickId:event.payload.clickId,orderId:order._id});}
   await sql.query("INSERT INTO referral_conversions(id,tenant_id,campaign_id,click_id,client_id,dedupe_key,source,consent_at) SELECT $1,$2,$3,$4,$5,$6,'verified_checkout',$7::timestamptz WHERE NOT EXISTS(SELECT 1 FROM referral_conversions WHERE tenant_id=$2 AND campaign_id=$3 AND client_id=$5) ON CONFLICT DO NOTHING",[id('conversion'),tenantId,c.campaign_id,event.payload.clickId,lead.id,`ghl-contact:${contactId}`,order.createdAt]);
   const key=`provider:${p.paymentProviderType}:${p.paymentProviderConnectedAccount}:${p.chargeId}`;
   const saved=await recordPayment(sql,u,{clientId:lead.id,eventKey:key,externalId:p._id,source:'ghl',date,amountMinor:amount,currency,status:'confirmed',productId,notes:'Automatically verified GHL checkout'},{campaignId:c.campaign_id,referrerId:c.salesperson_id});
   const refunded=decimalToMinor(String(p.amountRefunded||'0'),digits),previous=(await sql.query('SELECT COALESCE(-sum(amount_minor),0)::text AS total FROM payments WHERE tenant_id=$1 AND parent_payment_id=$2',[tenantId,saved.id])).rows[0].total;
   if(minor(refunded)>minor(previous))await recordRefund(sql,u,{paymentId:saved.id,eventKey:`refund-total:${p._id}:${refunded}`,amountMinor:(minor(refunded)-minor(previous)).toString(),date:dateInZone(p.updatedAt||p.createdAt,w.timezone),reason:'Verified cumulative GHL refund'});
   results.push({transactionId:p._id,paymentId:saved.id,amountMinor:amount,currency});
  }
  const status=mode==='live'?'auto_posted':'test_calculated';await sql.query('UPDATE tracker_inbox SET status=$3,payload=payload||$4::jsonb,reason=NULL,reviewed_at=now() WHERE tenant_id=$1 AND id=$2',[tenantId,eventId,status,JSON.stringify({results,orderSummary:{customerName:pContactName(contact),productName:item.name||'',createdAt:order.createdAt}})]);
  await sql.query("UPDATE campaigns SET verification_status=$3 WHERE tenant_id=$1 AND id=$2",[tenantId,c.campaign_id,mode==='live'?'verified_sale':'verified_test']);return{status};
 });
}

export async function retryCheckout(db:Database,u:SessionUser,b:any){admin(u);return reconcileCheckout(db,u.tenantId,String(b.id||''));}
