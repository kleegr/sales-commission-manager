import type {SessionUser} from './auth.js';
import {TrackerError,type SQL} from './tracker-common.js';
import {approvalState} from './proposal-suite.js';

export function notificationScope(u:SessionUser,alias='d'){
  if(['owner','admin'].includes(u.role))return {sql:`${alias}.tenant_id=$1`,params:[u.tenantId]};
  if(u.role==='sales_manager')return {sql:`${alias}.tenant_id=$1 AND ${alias}.salesperson_id IN (SELECT id FROM salespeople WHERE tenant_id=$1 AND manager_user_id=$2)`,params:[u.tenantId,u.id]};
  if(['salesperson','affiliate','partner'].includes(u.role))return {sql:`${alias}.tenant_id=$1 AND ${alias}.salesperson_id=$2`,params:[u.tenantId,u.salespersonId||'__none__']};
  throw new TrackerError('forbidden','This account cannot access notifications.',403);
}
export async function proposalAttention(db:SQL,u:SessionUser,docs:any[]){
  if(!docs.length)return {};
  const ids=docs.map(d=>d.id);
  const ws=(await db.query('SELECT * FROM proposal_workspaces WHERE tenant_id=$1 AND document_id=ANY($2::text[])',[u.tenantId,ids])).rows;
  const messages=(await db.query(`SELECT m.document_id,count(*)::int AS count FROM proposal_messages m WHERE m.tenant_id=$1 AND m.document_id=ANY($2::text[]) AND m.source='client' AND NOT EXISTS(SELECT 1 FROM notification_reads r WHERE r.tenant_id=$1 AND r.user_id=$3 AND r.notification_key='message:'||m.id) GROUP BY m.document_id`,[u.tenantId,ids,u.id])).rows;
  const policy=(await db.query('SELECT policy FROM proposal_policies WHERE tenant_id=$1',[u.tenantId])).rows[0]?.policy||{};
  const terms=policy.customTerms?(await db.query("SELECT profile->>'paymentTerms' AS payment_terms FROM business_profiles WHERE tenant_id=$1",[u.tenantId])).rows[0]?.payment_terms||'':'';
  const result:Record<string,any>={};
  for(const d of docs){const w=ws.find(w=>w.document_id===d.id)||{options:{},approval_status:'not_requested'};
    const a=await approvalState(db,d,w,{policy,terms});
    result[d.id]={approvalStatus:a.status,needsApproval:d.status==='draft'&&(a.required&&a.status!=='approved'||a.status==='pending'||a.status==='rejected'),unreadQuestions:messages.find(m=>m.document_id===d.id)?.count||0};
  }return result;
}
export async function notificationFeed(db:SQL,u:SessionUser,flags:Record<string,boolean>={}){
  const scope=notificationScope(u);
  const docs=(await db.query(`SELECT d.* FROM documents d WHERE ${scope.sql} ORDER BY d.updated_at DESC`,scope.params)).rows.filter(d=>d.kind==='contract'?flags.contracts!==false:flags.proposals!==false);
  const attention=await proposalAttention(db,u,docs),ids=docs.map(d=>d.id);
  const reads=new Set((await db.query('SELECT notification_key FROM notification_reads WHERE tenant_id=$1 AND user_id=$2',[u.tenantId,u.id])).rows.map(r=>r.notification_key));
  const items:any[]=[];
  const add=(key:string,title:string,detail:string,category:string,at:any,doc:any,tab='overview',actionRequired=false)=>items.push({id:key,title,detail,category,at:at||null,documentId:doc?.id,documentTitle:doc?.title||'',href:doc?`/documents?proposal=${encodeURIComponent(doc.id)}&workspace=${tab}`:'/payouts',read:reads.has(key),actionRequired});
  for(const d of docs){const a=attention[d.id];if(a.needsApproval)add(`approval:${d.id}:${a.approvalStatus}:${d.updated_at}`,a.approvalStatus==='pending'?'Internal approval pending':a.approvalStatus==='rejected'?'Internal changes requested':'Internal approval required','Review this offer before sharing it with the client.','approval',d.updated_at,d,'approval',true);}
  if(ids.length){
    const messages=(await db.query("SELECT * FROM proposal_messages WHERE tenant_id=$1 AND document_id=ANY($2::text[]) AND source='client' ORDER BY created_at DESC LIMIT 500",[u.tenantId,ids])).rows;
    for(const m of messages)add(`message:${m.id}`,m.request_change?'Client requested changes':'New client question',`${m.author}: ${m.message}`,'question',m.created_at,docs.find(d=>d.id===m.document_id),'conversation');
    const events=(await db.query("SELECT * FROM proposal_events WHERE tenant_id=$1 AND document_id=ANY($2::text[]) AND kind NOT IN ('message_added','change_requested','approval_requested') ORDER BY created_at DESC LIMIT 200",[u.tenantId,ids])).rows;
    for(const e of events)add(`event:${e.id}`,e.kind.replace(/_/g,' '),e.detail,'proposal',e.created_at,docs.find(d=>d.id===e.document_id));
    const due=(await db.query("SELECT document_id,options->>'followUpDate' AS due FROM proposal_workspaces WHERE tenant_id=$1 AND document_id=ANY($2::text[]) AND options->>'followUpDate'<>'' AND options->>'followUpDate'<=to_char(now(),'YYYY-MM-DD')",[u.tenantId,ids])).rows;
    for(const f of due){const d=docs.find(d=>d.id===f.document_id);if(d&& !['signed','canceled'].includes(d.status))add(`followup:${d.id}:${f.due}`,'Follow-up due',`Follow up with the client. Scheduled for ${f.due}.`,'followup',f.due,d,'overview',true);}
  }
  const payouts=flags.payouts===false?[]:(await db.query(`SELECT d.* FROM payout_batches d WHERE ${scope.sql} ORDER BY d.updated_at DESC LIMIT 100`,scope.params)).rows;
  for(const p of payouts)add(`payout:${p.id}:${p.status}:${p.updated_at}`,`Payout ${p.status}`,`Payout ${p.id}`,'payout',p.updated_at,null,'overview',['submitted','approved'].includes(p.status));
  items.sort((a,b)=>Number(b.actionRequired)-Number(a.actionRequired)||Number(!b.read)-Number(!a.read)||(Date.parse(b.at)||0)-(Date.parse(a.at)||0));
  return {items,unread:items.filter(i=>!i.read).length};
}
export async function markNotifications(db:SQL,u:SessionUser,input:any,flags:Record<string,boolean>={}){
  const feed=await notificationFeed(db,u,flags);
  const requested=new Set(Array.isArray(input.ids)?input.ids.map(String):[]);
  const items=feed.items.filter(i=>requested.has(i.id)||(input.documentId&&i.documentId===input.documentId&&i.category==='question'));
  if(items.length)await db.query('INSERT INTO notification_reads(tenant_id,user_id,notification_key) SELECT $1,$2,key FROM unnest($3::text[]) AS key ON CONFLICT DO NOTHING',[u.tenantId,u.id,items.map(i=>i.id)]);
  return {ok:true,count:items.length};
}
