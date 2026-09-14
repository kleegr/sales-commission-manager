// /api/proposal — FLOW 4: the UNAUTHENTICATED public approval endpoint.
//   GET  ?token=<raw>                              -> rendered document (marks 'viewed' on first open)
//   POST {token,name,email,signature,agree:true}   -> approve & sign; ONE transaction that also creates the
//                                                     client (prospect mode), a won opportunity and a PENDING
//                                                     receipt for the document's salesperson (idempotent).
// TOKEN DESIGN: 32 random bytes, base64url (43 chars) — returned ONCE by the authenticated send/link ops in
// /api/documents; only sha256(token) is stored in documents.public_token (same rule as sessions + Kleegr launch
// tokens). Re-sending or "new link" ROTATES the token (the previously shared link stops working). Links expire
// PROPOSAL_LINK_TTL_DAYS after issue. Tenant, client and salesperson are derived from the token's row — nothing
// in the request body is trusted for ids. Rate limited per IP (DB sliding window, fail-open like rate-limit.ts).
import {createHash,randomBytes} from 'node:crypto';
import type {VercelRequest,VercelResponse} from '@vercel/node';
import {hasDb} from './_lib/db.js';
import {ensureSchema} from './_lib/repository.js';
import {csrfOk,clientIp} from './_lib/http.js';
import type {SessionUser} from './_lib/auth.js';
import {audit,database,id,lock,trackerInstalled,TrackerError,type SQL} from './_lib/tracker-common.js';
import {recordPayment} from './_lib/tracker-finance.js';
import {rowToDocument,rowToBusinessProfile,prospectAsClient,receiptAmount,toMinor,normalizeAcceptance,proposalOverLimit,PROPOSAL_WINDOW_MIN,type ClientDocumentRow} from './_lib/documents-core.js';
import {applySectionsMerge,buildMergeContext,canTransitionStatus} from '../src/lib/documents.js';

export const PROPOSAL_LINK_TTL_DAYS=60;
const TOKEN_RE=/^[A-Za-z0-9_-]{43}$/;
export const hashToken=(t:string)=>createHash('sha256').update(t).digest('hex');
export const mintToken=()=>randomBytes(32).toString('base64url');
export const proposalLink=(origin:string,token:string)=>`${origin.replace(/\/+$/,'')}/p/${token}`;
const iso=(v:any)=>v?new Date(v).toISOString():null;
const ACCEPT_MESSAGES:Record<string,string>={name_required:'Enter your full name.',email_invalid:'Enter a valid email address.',signature_required:'Type your name as your signature.',agreement_required:'Tick the box to confirm you agree.'};

/** Calendar date in the workspace timezone (receipt dates are calendar dates, see reviewEvent). */
export function calendarDate(timeZone:string,now=new Date()){try{const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);const p=(k:string)=>parts.find(v=>v.type===k)?.value;return `${p('year')}-${p('month')}-${p('day')}`;}catch{return now.toISOString().slice(0,10);}}

/** Mint a fresh token for a tenant-scoped document (rotating any previous one) and move it to 'sent'. Returns the raw token ONCE. */
export async function issueProposalLink(db:SQL,tenantId:string,docId:string,opts:{to?:string|null;resend?:boolean}={}){
  const row=(await db.query('SELECT * FROM documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,docId])).rows[0];if(!row)throw new TrackerError('not_found','Document not found.',404);
  const from=String(row.status||'draft');if(!canTransitionStatus(from as any,'sent'))throw new TrackerError('invalid_transition','Only draft, sent or viewed documents can be shared.',409);
  const token=mintToken(),hash=hashToken(token),status=from==='viewed'?'viewed':'sent';
  const r=await db.query(`UPDATE documents SET public_token=$3,token_expires_at=now()+make_interval(days=>$4),status=$5,sent_at=CASE WHEN $6::boolean THEN now() ELSE COALESCE(sent_at,now()) END,sent_to=COALESCE($7,sent_to),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING token_expires_at`,[tenantId,docId,hash,PROPOSAL_LINK_TTL_DAYS,status,opts.resend===true,opts.to||null]);
  return{token,hash,status,expiresAt:iso(r.rows[0]?.token_expires_at)};
}
/** Plain-text email carrying the approval link. */
export function proposalEmail(i:{title:string;businessName:string;recipientName:string;salespersonName:string;link:string;expiresAt:string|null}){
  const who=i.businessName||i.salespersonName||'Your provider';const subject=`${who}: ${i.title}`.slice(0,300);
  const body=[`Hi ${i.recipientName||'there'},`,'',`${who} has prepared "${i.title}" for you.`,'','Review and approve it here:',i.link,'',i.expiresAt?`This link expires on ${i.expiresAt.slice(0,10)}.`:'',i.salespersonName?`Questions? Reply to this email or contact ${i.salespersonName}.`:'','',`— ${who}`].filter((l,k,a)=>l!==''||a[k-1]!=='').join('\n');
  return{subject,body};
}

async function loadByToken(db:SQL,token:string,forUpdate=false){
  if(!TOKEN_RE.test(token))throw new TrackerError('invalid_token','This link is not valid.',404);
  const row=(await db.query(`SELECT * FROM documents WHERE public_token=$1${forUpdate?' FOR UPDATE':''}`,[hashToken(token)])).rows[0];if(!row)throw new TrackerError('invalid_token','This link is not valid.',404);
  if(row.token_expires_at&&new Date(row.token_expires_at).getTime()<Date.now())throw new TrackerError('link_expired','This link has expired. Ask your contact for a new one.',410);
  if(row.status==='canceled'||row.status==='draft')throw new TrackerError('unavailable','This document is no longer available.',410);
  return row;
}
async function render(db:SQL,row:any){
  const d:ClientDocumentRow=rowToDocument(row),tenantId=row.tenant_id;
  const bp=(await db.query('SELECT * FROM business_profiles WHERE tenant_id=$1',[tenantId])).rows[0],business=bp?rowToBusinessProfile(bp):null;
  const tenant=(await db.query('SELECT name FROM tenants WHERE id=$1',[tenantId])).rows[0];
  const client=d.clientId?(await db.query('SELECT * FROM clients WHERE tenant_id=$1 AND id=$2',[tenantId,d.clientId])).rows[0]:null;
  const sp=d.salespersonId?(await db.query('SELECT name,email FROM salespeople WHERE tenant_id=$1 AND id=$2',[tenantId,d.salespersonId])).rows[0]:null;
  const merge=client?{companyName:client.company_name,contactName:client.contact_name,email:client.email,phone:client.phone,setupFee:Number(client.setup_fee_amount||0),monthlySubscription:Number(client.monthly_subscription_amount||0),signupDate:client.signup_date||''}:d.prospect?prospectAsClient(d.prospect):null;
  const currency=(await trackerInstalled(db))?(await db.query('SELECT currency FROM tracker_workspaces WHERE tenant_id=$1',[tenantId])).rows[0]?.currency||'USD':'USD';
  const setupFee=merge?.setupFee||0,monthly=merge?.monthlySubscription||0,total=merge?setupFee+monthly:d.amount;
  return{kind:d.kind,title:d.title,style:d.style,status:d.status,sections:applySectionsMerge(d.sections,buildMergeContext({business,client:merge,salespersonName:sp?.name||''})),
    branding:{businessName:business?.businessName||tenant?.name||'',logoUrl:business?.logoUrl||'',website:business?.website||'',companyAddress:business?.companyAddress||'',contactEmail:business?.contactEmail||'',contactPhone:business?.contactPhone||'',brandTone:business?.brandTone||'professional'},
    recipient:merge?{name:merge.contactName,company:merge.companyName,email:merge.email}:null,salesperson:sp?{name:sp.name,email:sp.email}:null,
    amount:{total,setupFee,monthly,dueNow:receiptAmount(setupFee,total),currency},accepted:d.status==='signed'?{name:d.acceptedByName,at:d.acceptedAt||d.signedAt}:null,sentAt:d.sentAt};
}
/** GET: render for the recipient; the first open of a 'sent' document marks it 'viewed'. */
export async function viewProposal(db:SQL,token:string){
  const row=await loadByToken(db,token);
  if(row.status==='sent'){await db.query("UPDATE documents SET status='viewed',viewed_at=now(),updated_at=now() WHERE id=$1 AND status='sent'",[row.id]);row.status='viewed';}
  return render(db,row);
}
/** POST: approve & sign. Idempotent — a second call on a signed document is a read-only no-op. Must run inside ONE transaction. */
export async function acceptProposal(db:SQL,token:string,b:any,ip:string){
  const form=normalizeAcceptance(b);if(!form.ok)throw new TrackerError(form.error,ACCEPT_MESSAGES[form.error]||'Check the form and try again.');
  const row=await loadByToken(db,token,true),tenantId:string=row.tenant_id;
  if(row.status==='signed')return{ok:true,alreadyAccepted:true,accepted:{name:row.accepted_by_name,at:iso(row.accepted_at||row.signed_at)},clientId:row.client_id||row.created_client_id,clientCreated:false,opportunityId:row.created_opportunity_id,receipt:row.receipt_event_key?'recorded':'skipped',receiptError:null};
  const d=rowToDocument(row),{name,email,signature}=form.value,now=new Date();await lock(db,tenantId);
  await db.query(`UPDATE documents SET status='signed',signed_at=now(),accepted_at=now(),accepted_by_name=$2,accepted_email=$3,accepted_ip=$4,signature_data=$5,updated_at=now() WHERE id=$1`,[row.id,name,email,ip.slice(0,64),signature]);
  const tracker=await trackerInstalled(db);
  const sp=d.salespersonId?(await db.query('SELECT id FROM salespeople WHERE tenant_id=$1 AND id=$2',[tenantId,d.salespersonId])).rows[0]:null,spId:string|null=sp?.id||null;
  let clientId=d.clientId,clientCreated=false,client=clientId?(await db.query('SELECT * FROM clients WHERE tenant_id=$1 AND id=$2',[tenantId,clientId])).rows[0]:null;
  if(!client){
    const p=d.prospect||{name,email,company:'',phone:'',setupFee:0,monthlySubscription:0},stamp=now.toISOString();clientId=id('client');clientCreated=true;
    const base=['id','tenant_id','salesperson_id','company_name','contact_name','email','phone','signup_date','setup_fee_amount','monthly_subscription_amount','status','notes','created_at','updated_at'],vals:any[]=[clientId,tenantId,spId,p.company||p.name,p.name,p.email,p.phone,stamp.slice(0,10),p.setupFee,p.monthlySubscription,'active',`Created automatically when "${d.title}" was approved by ${name}.`,stamp,stamp];
    if(tracker){base.push('referrer_id','original_source','attribution_method','attribution_evidence','attribution_at','attribution_status');vals.push(spId,'proposal',spId?'manual':null,`document:${d.id}`,spId?stamp:null,spId?'attributed':'unattributed');}
    await db.query(`INSERT INTO clients(${base.join(',')}) VALUES(${base.map((_,k)=>`$${k+1}`).join(',')})`,vals);
    client=(await db.query('SELECT * FROM clients WHERE tenant_id=$1 AND id=$2',[tenantId,clientId])).rows[0];
  }
  let opportunityId:string|null=null,receiptEventKey:string|null=null,receipt:'recorded'|'skipped'|'failed'='skipped',receiptError:string|null=null;
  const w=tracker?(await db.query('SELECT * FROM tracker_workspaces WHERE tenant_id=$1',[tenantId])).rows[0]:null;
  if(w){
    await db.query('SAVEPOINT flow4_finance');
    try{
      const digits=Number(w.payout_terms?.minorDigits??2),setupFee=Number(client.setup_fee_amount||0),total=setupFee+Number(client.monthly_subscription_amount||0),dueNow=receiptAmount(setupFee,total);
      opportunityId=id('opp');await db.query(`INSERT INTO opportunities(id,tenant_id,client_id,name,owner_id,value_minor,currency,status,source,won_at) VALUES($1,$2,$3,$4,$5,$6,$7,'won','manual',now())`,[opportunityId,tenantId,clientId,d.title,spId,toMinor(total,digits),w.currency]);
      if(dueNow>0){
        const system:SessionUser={id:`proposal:${d.id}`,tenantId,tenantSlug:'',tenantName:'',name,email,role:'owner',salespersonId:null},key=`proposal:${d.id}`;
        await recordPayment(db,system,{eventKey:key,clientId,opportunityId,date:calendarDate(w.timezone||'UTC',now),amountMinor:toMinor(dueNow,digits),currency:w.currency,status:'pending',source:'manual',productId:'',notes:`"${d.title}" approved by ${name} (${email}). Confirm when the cash arrives.`});
        receiptEventKey=key;receipt='recorded';
      }
      await db.query('RELEASE SAVEPOINT flow4_finance');
    }catch(e){await db.query('ROLLBACK TO SAVEPOINT flow4_finance');opportunityId=null;receiptEventKey=null;receipt='failed';receiptError=e instanceof TrackerError?e.code:'internal_error';console.error('[scm:error] proposal finance:',e instanceof Error?e.message:String(e));}
  }
  await db.query('UPDATE documents SET created_client_id=$2,created_opportunity_id=$3,receipt_event_key=$4 WHERE id=$1',[row.id,clientCreated?clientId:null,opportunityId,receiptEventKey]);
  await audit(db,{id:`proposal:${d.id}`,tenantId,tenantSlug:'',tenantName:'',name,email,role:'owner',salespersonId:null},'document',d.id,'proposal_accepted',{acceptedBy:name,acceptedEmail:email,clientId,clientCreated,opportunityId,receipt,receiptError});
  return{ok:true,alreadyAccepted:false,accepted:{name,at:now.toISOString()},clientId,clientCreated,opportunityId,receipt,receiptError};
}

// ---- per-IP sliding window (fail-open) ----
export async function proposalLimited(db:SQL,ip:string){if(!ip)return false;try{const r=(await db.query('SELECT count(*)::int AS total,count(*) FILTER (WHERE NOT ok)::int AS failures FROM proposal_access_log WHERE ip=$1 AND created_at>now()-make_interval(mins=>$2)',[ip,PROPOSAL_WINDOW_MIN])).rows[0];return proposalOverLimit(Number(r?.total||0),Number(r?.failures||0));}catch{return false;}}
export async function recordProposalAccess(db:SQL,ip:string,ok:boolean){if(!ip)return;try{await db.query('DELETE FROM proposal_access_log WHERE created_at<=now()-make_interval(mins=>$1)',[PROPOSAL_WINDOW_MIN]);await db.query('INSERT INTO proposal_access_log(ip,ok) VALUES($1,$2)',[ip,ok]);}catch{/* best-effort */}}

export default async function handler(req:VercelRequest,res:VercelResponse){
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex');
  if(!hasDb())return res.status(503).json({error:'database_not_configured'});
  const ip=clientIp(req);
  try{
    await ensureSchema();
    if(await proposalLimited(database,ip))return res.status(429).json({error:'rate_limited',message:'Too many requests. Please try again in a few minutes.'});
    const run=async<T>(fn:()=>Promise<T>)=>{try{const out=await fn();await recordProposalAccess(database,ip,true);return out;}catch(e){await recordProposalAccess(database,ip,!(e instanceof TrackerError&&[404,410].includes(e.status)));throw e;}};
    if(req.method==='GET')return res.json(await run(()=>database.transaction(db=>viewProposal(db,String(req.query.token||'')))));
    if(req.method!=='POST'){res.setHeader('Allow','GET, POST');return res.status(405).json({error:'method_not_allowed'});}
    if(!csrfOk(req))return res.status(403).json({error:'csrf_check_failed'});
    const b=typeof req.body==='string'?JSON.parse(req.body||'{}'):req.body??{};if(JSON.stringify(b).length>4000)return res.status(413).json({error:'too_large'});
    const out=await run(()=>database.transaction(db=>acceptProposal(db,String(b.token||''),b,ip)));
    return res.json({ok:true,accepted:out.accepted,alreadyAccepted:out.alreadyAccepted});
  }catch(e){
    if(e instanceof TrackerError)return res.status(e.status).json({error:e.code,message:e.message});
    console.error('[scm:error] proposal:',e instanceof Error?(e.stack??e.message):String(e));return res.status(500).json({error:'internal_error'});
  }
}
