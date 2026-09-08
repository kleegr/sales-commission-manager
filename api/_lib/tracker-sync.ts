import type {SessionUser} from './auth.js';
import {admin,audit,database,dateOnly,id,lock,required,TrackerError,workspace,type Database,type SQL} from './tracker-common.js';
import {resolveDirectoryTokens} from './ghl-directory.js';
import {decimalToMinor} from '../../src/lib/exact-commission.js';
import {recordPayment} from './tracker-finance.js';

/** Only explicit resource previews use these endpoints. Directory's verified contract is unchanged. */
export async function readProviderPage(locationId:string,resource:string,cursor:number,fetchImpl:typeof fetch=fetch){
  const tokens=await resolveDirectoryTokens(locationId,fetchImpl),params=new URLSearchParams({limit:'100'});
  if(resource==='payments'){params.set('altId',locationId);params.set('altType','location');params.set('offset',String(cursor));}
  else if(resource==='opportunities'){params.set('locationId',locationId);params.set('page',String(cursor/100+1));}
  else throw new TrackerError('unsupported_resource','Preview supports opportunities and payment transactions.');
  let response:Response;
  try{response=await fetchImpl(`https://services.leadconnectorhq.com/${resource==='payments'?'payments/transactions':'opportunities/search'}?${params}`,{headers:{Authorization:`Bearer ${tokens.location.accessToken}`,Version:'v3',accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new TrackerError('provider_unreachable','Provider request failed; the saved checkpoint can be retried.',502);}
  if(!response.ok)throw new TrackerError(response.status===429?'rate_limited':response.status===403?'scope_required':'provider_error',response.status===403?`The connected app needs ${resource==='payments'?'payments/transactions.readonly':'opportunities.readonly'} access for this resource.`:'The provider could not complete this page. Previously reviewed data was preserved.',response.status===429?429:502);
  const body:any=await response.json(),raw=resource==='payments'?body.data:body.opportunities;
  if(!Array.isArray(raw))throw new TrackerError('invalid_page','The provider returned an unexpected page.');
  const rows=raw.map((r:any)=>{
    if((r.locationId&&r.locationId!==locationId)||(r.altId&&r.altId!==locationId))throw new TrackerError('tenant_mismatch','Provider returned a record outside this location.');
    if(resource==='payments')return{externalId:required(r._id,'Transaction ID'),contactId:String(r.contactId||''),currency:String(r.currency||'').toUpperCase(),amount:String(r.amount),status:String(r.status),chargeId:typeof r.chargeId==='string'?r.chargeId.trim():'',providerAccount:typeof r.paymentProviderConnectedAccount==='string'?r.paymentProviderConnectedAccount.trim():'',provider:typeof r.paymentProviderType==='string'?r.paymentProviderType.trim():'',createdAt:r.createdAt,updatedAt:r.updatedAt,amountRefunded:String(r.amountRefunded||'0'),liveMode:r.liveMode};
    return{externalId:required(r.id,'Opportunity ID'),contactId:String(r.contactId||r.contact?.id||''),name:String(r.name||''),status:String(r.status||'open'),monetaryValue:String(r.monetaryValue||'0'),pipelineId:r.pipelineId||null,stageId:r.pipelineStageId||null,assignedTo:r.assignedTo||null,updatedAt:r.updatedAt||r.dateUpdated||null};
  });
  const total=resource==='payments'?body.totalCount:body.meta?.total;
  return{rows,next:cursor+raw.length,done:raw.length<100||(typeof total==='number'&&cursor+raw.length>=total)};
}
export async function previewSync(u:SessionUser,b:any,db:Database=database,reader=readProviderPage){
  admin(u);const resource=required(b.resource,'Resource');if(!['payments','opportunities'].includes(resource))throw new TrackerError('unsupported_resource','Choose opportunities or payment transactions.');
  const location=(await db.query("SELECT ghl_location_id FROM tenants WHERE id=$1 AND status='active' AND kleegr_connection_status='connected'",[u.tenantId])).rows[0]?.ghl_location_id;if(!location)throw new TrackerError('not_connected','Open this workspace from the connected sub-account.');
  const run=await db.transaction(async c=>{await lock(c,u.tenantId);if(b.runId){const old=(await c.query('SELECT * FROM sync_runs WHERE tenant_id=$1 AND id=$2 AND resource=$3 FOR UPDATE',[u.tenantId,b.runId,resource])).rows[0];if(!old)throw new TrackerError('not_found','Sync run not found.');if(old.status==='completed')return old;if(old.next_retry_at&&new Date(old.next_retry_at).getTime()>Date.now())throw new TrackerError('retry_later','Wait until the displayed retry time before resuming.',429);await c.query("UPDATE sync_runs SET status='running',attempts=attempts+1,next_retry_at=now()+interval '2 minutes' WHERE tenant_id=$1 AND id=$2",[u.tenantId,old.id]);return old;}
    const active=(await c.query("SELECT id FROM sync_runs WHERE tenant_id=$1 AND resource=$2 AND status<>'completed' AND next_retry_at>now()",[u.tenantId,resource])).rows[0];if(active)throw new TrackerError('sync_in_progress','This resource already has an active or delayed run.',409);
    const runId=id('sync');await c.query("INSERT INTO sync_runs(id,tenant_id,resource,status,attempts,actor_id,next_retry_at) VALUES($1,$2,$3,'running',1,$4,now()+interval '2 minutes')",[runId,u.tenantId,resource,u.id]);return{id:runId,cursor:{offset:0},status:'running',attempts:0};});
  if(run.status==='completed')return{id:run.id,completed:true};
  try{const offset=Number(run.cursor.offset||0),page=await reader(location,resource,offset);
    if(!page.done&&page.next<=offset)throw new TrackerError('pagination_stalled','Provider pagination did not advance.');
    await db.transaction(async c=>{await lock(c,u.tenantId);for(const row of page.rows)await c.query(`INSERT INTO import_reviews(id,tenant_id,resource,external_id,payload,reason) VALUES($1,$2,$3,$4,$5::jsonb,'Preview only. Match the contact, verify amount units, currency and canonical charge before approval.') ON CONFLICT(tenant_id,resource,external_id) DO UPDATE SET payload=EXCLUDED.payload,reason=EXCLUDED.reason,status=CASE WHEN import_reviews.payload=EXCLUDED.payload THEN import_reviews.status ELSE 'pending' END WHERE COALESCE(import_reviews.payload->>'updatedAt','')<=COALESCE(EXCLUDED.payload->>'updatedAt','')`,[id('import'),u.tenantId,resource,row.externalId,JSON.stringify(row)]);
      await c.query("UPDATE sync_runs SET cursor=$3::jsonb,status=$4,error=NULL,next_retry_at=NULL,completed_at=CASE WHEN $4='completed' THEN now() ELSE NULL END WHERE tenant_id=$1 AND id=$2",[u.tenantId,run.id,JSON.stringify({offset:page.next}),page.done?'completed':'pending']);await audit(c,u,'sync',run.id,'page_staged',{resource,count:page.rows.length,offset:page.next,completed:page.done});});
    return{id:run.id,count:page.rows.length,completed:page.done,next:page.next};
  }catch(e){const code=e instanceof TrackerError?e.code:'sync_failed',delay=Math.min(3600,30*2**Math.min(Number(run.attempts||0),7));await db.query("UPDATE sync_runs SET status='failed',error=$3,next_retry_at=now()+($4||' seconds')::interval WHERE tenant_id=$1 AND id=$2",[u.tenantId,run.id,code,String(delay)]);throw e;}
}
export async function approveImport(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const r=(await db.query('SELECT * FROM import_reviews WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[u.tenantId,b.id])).rows[0];if(!r)throw new TrackerError('not_found','Import review not found.');if(r.status==='approved')return{duplicate:true};
  const reason=required(b.reason,'Review evidence');if(b.reject){await db.query("UPDATE import_reviews SET status='rejected',reason=$3,reviewed_by=$4 WHERE tenant_id=$1 AND id=$2",[u.tenantId,r.id,reason,u.id]);await audit(db,u,'import',r.id,'rejected',{reason});return{ok:true};}
  const p=r.payload,w=await workspace(db,u);const contact=(await db.query('SELECT id,referrer_id FROM clients WHERE tenant_id=$1 AND (ghl_contact_id=$2 OR kleegr_contact_id=$2)',[u.tenantId,p.contactId])).rows;
  const clientId=b.clientId|| (contact.length===1?contact[0].id:null);if(!clientId)throw new TrackerError('unmatched_contact','Match this provider contact to a local lead before approving.');
  if(r.resource==='payments'){
    if(b.confirmMapping!==true||p.status!=='succeeded'||!(p.liveMode===true||p.liveMode==='true'))throw new TrackerError('mapping_required','Confirm units and canonical identity. Only succeeded live transactions can become receipts.');
    if([p.chargeId,p.providerAccount,p.provider].some(v=>typeof v!=='string'||!v.trim()||v.length>200))throw new TrackerError('canonical_identity_required','This transaction lacks a verified provider charge/account identity. Keep it in review.');
    const amountMinor=b.amountUnits==='minor'?String(p.amount):b.amountUnits==='major'?decimalToMinor(String(p.amount),w.payout_terms.minorDigits??2):null;
    if(!amountMinor)throw new TrackerError('units_required','Confirm whether provider amount is in major or minor currency units.');
    await recordPayment(db,u,{eventKey:`provider:${p.provider}:${p.providerAccount}:${p.chargeId}`,externalId:p.externalId,source:'ghl',clientId,date:dateOnly(String(p.createdAt).slice(0,10)),amountMinor,currency:p.currency,status:'confirmed',productId:String(b.productId||''),assignmentParticipantId:b.assignmentParticipantId||undefined,confirmUnattributed:b.confirmUnattributed===true,notes:reason});
    // Refund events require separate explicit review against the original posted receipt.
    if(p.amountRefunded!=='0')await db.query("INSERT INTO attribution_reviews(id,tenant_id,client_id,method,evidence,reason) VALUES($1,$2,$3,'financial_review',$4,'Provider reports a refund. Match and record its exact amount against the posted receipt; no automatic reversal was made.')",[id('review'),u.tenantId,clientId,p.externalId]);
  }else if(r.resource==='opportunities'){
    if(b.confirmMapping!==true||b.amountUnits!=='major')throw new TrackerError('mapping_required','Confirm that opportunity values use major units in the configured workspace currency before importing.');
    const owner=(await db.query('SELECT id FROM salespeople WHERE tenant_id=$1 AND ghl_user_id=$2',[u.tenantId,p.assignedTo])).rows[0]?.id||null;
    if(!['open','won','lost','abandoned'].includes(p.status))throw new TrackerError('invalid_status','Provider opportunity status needs mapping.');
    await db.query(`INSERT INTO opportunities(id,tenant_id,external_id,client_id,name,pipeline_id,stage_id,owner_id,owner_external_id,value_minor,currency,status,source,provider_updated_at,synced_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ghl',$13,now()) ON CONFLICT(tenant_id,source,external_id) DO UPDATE SET name=EXCLUDED.name,pipeline_id=EXCLUDED.pipeline_id,stage_id=EXCLUDED.stage_id,owner_id=EXCLUDED.owner_id,owner_external_id=EXCLUDED.owner_external_id,value_minor=EXCLUDED.value_minor,status=EXCLUDED.status,provider_updated_at=EXCLUDED.provider_updated_at,synced_at=now() WHERE opportunities.provider_updated_at IS NULL OR opportunities.provider_updated_at<=EXCLUDED.provider_updated_at`,[id('opp'),u.tenantId,p.externalId,clientId,p.name,p.pipelineId,p.stageId,owner,p.assignedTo,decimalToMinor(p.monetaryValue,w.payout_terms.minorDigits??2),w.currency,p.status,p.updatedAt]);
  }else throw new TrackerError('unsupported_import','This webhook/resource remains in review until a supported mapping is configured.');
  await db.query("UPDATE import_reviews SET status='approved',reason=$3,reviewed_by=$4 WHERE tenant_id=$1 AND id=$2",[u.tenantId,r.id,reason,u.id]);await audit(db,u,'import',r.id,'approved',{resource:r.resource,externalId:r.external_id,reason});return{ok:true};
}
