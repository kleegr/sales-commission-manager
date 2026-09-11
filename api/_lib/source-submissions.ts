import type {SessionUser} from './auth.js';
import {admin,id,lock,TrackerError,type Database,type SQL} from './tracker-common.js';
import {gatewayPage} from './kleegr-read.js';

/** Inspect only the selected campaign's provider submissions. Unrelated contacts never enter the response. */
export async function checkSubmissions(db:Database,u:SessionUser,b:any,reader=gatewayPage){
 admin(u);
 const campaign=(await db.query('SELECT c.*,t.ghl_location_id FROM campaigns c JOIN tenants t ON t.id=c.tenant_id WHERE c.tenant_id=$1 AND c.id=$2',[u.tenantId,String(b.campaignId||'')])).rows[0];
 const source=campaign?.tracking_policy?.source?.selection;
 if(!campaign||!['form','survey','calendar'].includes(source?.kind))throw new TrackerError('submission_source_required','Choose a campaign connected to a GHL form, survey or calendar.');
 const page=Math.max(1,Math.min(1000,Math.floor(Number(b.page)||1)));
 const earliest=(await db.query('SELECT min(created_at) AS earliest FROM referral_clicks WHERE tenant_id=$1 AND campaign_id=$2',[u.tenantId,campaign.id])).rows[0].earliest;
 if(!earliest)return {checked:0,matched:0,unmatched:0,page,nextPage:null,rows:[],message:'Open a salesman’s affiliate link before checking submissions.'};
 let response:any,submissions:any[];
 if(source.kind==='calendar'){
  const eventId=String(b.appointmentId||'').trim();if(!/^[a-zA-Z0-9_-]{5,100}$/.test(eventId))throw new TrackerError('appointment_required','Paste the booking ID from the confirmed GHL appointment.');
  const event=(await reader(campaign.ghl_location_id,'appointment',0,fetch,{eventId,assetId:source.id})).payload?.event;
  if(!event||event.id!==eventId||event.calendarId!==source.id||!event.contactId||(event.locationId&&event.locationId!==campaign.ghl_location_id))throw new TrackerError('appointment_scope','The appointment does not match this calendar.');
  const contact=(await reader(campaign.ghl_location_id,'contact',0,fetch,{contactId:event.contactId})).payload?.contact;
  if(!contact||contact.id!==event.contactId||contact.locationId!==campaign.ghl_location_id)throw new TrackerError('contact_scope','The booking contact does not match this workspace.');
  const attribution=event.attributionSource||contact.lastAttributionSource||contact.attributionSource;
  const createdAt=event.dateAdded||event.createdAt;
  if(!createdAt||!attribution?.url)throw new TrackerError('booking_evidence_required','GHL did not provide a booking creation time and referral page URL. This booking cannot be credited automatically.');
  submissions=[{id:event.id,calendarId:event.calendarId,contactId:event.contactId,name:contact.name,createdAt,others:{eventData:{page:{url:attribution.url}}}}];response={payload:{meta:{nextPage:null}}};
 }else{
  response=await reader(campaign.ghl_location_id,source.kind==='form'?'formSubmissions':'surveySubmissions',(page-1)*100,fetch,{assetId:source.id,startAt:new Date(earliest).toISOString().slice(0,10),endAt:new Date(Date.now()+86400000).toISOString().slice(0,10)});
  submissions=response.payload?.submissions;
 }
 if(!Array.isArray(submissions)||submissions.length>100)throw new TrackerError('submission_mapping_required','GHL returned an unsupported submission format.');
 const rows:any[]=[];let unmatched=0;
 for(const s of submissions){
  if(String(s[source.kind==='calendar'?'calendarId':source.kind==='form'?'formId':'surveyId']||'')!==source.id){unmatched++;continue;}
  let url:URL;try{url=new URL(s.others?.eventData?.page?.url);}catch{unmatched++;continue;}
  const destination=new URL(campaign.destination_url);
  const clickId=url.searchParams.get('referralClick');
  if(!clickId||url.origin!==destination.origin||url.pathname!==destination.pathname){unmatched++;continue;}
  const click=(await db.query('SELECT k.*,sp.name AS salesman_name FROM referral_clicks k JOIN salespeople sp ON sp.tenant_id=k.tenant_id AND sp.id=k.salesperson_id WHERE k.tenant_id=$1 AND k.campaign_id=$2 AND k.id=$3',[u.tenantId,campaign.id,clickId])).rows[0];
  const occurred=Date.parse(s.createdAt);
  if(!click||!Number.isFinite(occurred)||occurred>Date.now()+30000||occurred<new Date(click.created_at).getTime()-30000||occurred>new Date(click.expires_at).getTime()||!s.id||!s.contactId){unmatched++;continue;}
  const result={submissionId:String(s.id),salesman:click.salesman_name,customer:String(s.name||'Form visitor').slice(0,200),kind:source.kind,submittedAt:s.createdAt,clickId};
  if(b.capture===true)await db.transaction(async sql=>{
   await lock(sql,u.tenantId);
   const externalId=`${source.kind}:${source.id}:${s.id}`;
   const old=(await sql.query("SELECT id,payload FROM tracker_inbox WHERE tenant_id=$1 AND provider='ghl-submission' AND external_id=$2",[u.tenantId,externalId])).rows[0];
   if(old){if(old.payload.clickId!==clickId)throw new TrackerError('submission_conflict','This submission already belongs to another referral.',409);return;}
   // Connection tests are evidence only. They never create clients, orders, earnings or payouts.
   await sql.query("INSERT INTO tracker_inbox(id,tenant_id,provider,external_id,kind,payload,status) VALUES($1,$2,'ghl-submission',$3,'lead',$4::jsonb,'test_submission')",[id('submission'),u.tenantId,externalId,JSON.stringify({...result,contactId:String(s.contactId),mode:'test'})]);
  });
  rows.push(result);
 }
 return {checked:submissions.length,matched:rows.length,unmatched,page,nextPage:response.payload.meta?.nextPage? page+1:null,rows,message:b.capture?(rows.length?'Matched test submissions recorded. No money or clients were created.':'No matching test submissions were recorded. GHL may need a moment to publish a new submission.'):'Read-only check. No records were changed.'};
}
export async function submissionTests(db:SQL,u:SessionUser,campaignId:string){
 admin(u);return {rows:(await db.query("SELECT e.id,e.status,e.created_at,e.payload->>'customer' AS customer,e.payload->>'salesman' AS salesman,e.payload->>'kind' AS kind,e.payload->>'submittedAt' AS submitted_at FROM tracker_inbox e JOIN referral_clicks k ON k.tenant_id=e.tenant_id AND k.id=e.payload->>'clickId' WHERE e.tenant_id=$1 AND k.campaign_id=$2 AND e.provider='ghl-submission' ORDER BY e.created_at DESC LIMIT 50",[u.tenantId,campaignId])).rows};
}
