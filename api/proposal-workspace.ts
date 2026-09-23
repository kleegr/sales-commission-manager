import {isNewProposalDraftKey} from '../src/lib/proposal-draft-key.js';
import type {VercelRequest,VercelResponse} from '@vercel/node';
import {ensureSchema} from './_lib/repository.js';
import {getSessionUser} from './_lib/auth.js';
import {csrfOk} from './_lib/http.js';
import {readTenantFlags} from './_lib/feature-access.js';
import {canCreateClientDoc} from './_lib/documents-core.js';
import {admin,database,id,TrackerError} from './_lib/tracker-common.js';
import {addProposalMessage,approvalState,canReview,canSeeCosts,documentFingerprint,normalizeOptions,normalizeProductPolicy,scopedProposal,suiteEvent,workspaceFor,workspaceResponse} from './_lib/proposal-suite.js';
import {emptyProposalOptions} from '../src/lib/proposal-suite.js';

export default async function handler(req:VercelRequest,res:VercelResponse){
  res.setHeader('Cache-Control','no-store');
  try{
    await ensureSchema();const user=await getSessionUser(req);if(!user)return res.status(401).json({error:'unauthorized'});
    const flags=await readTenantFlags(user.tenantId);if(flags.proposals===false)return res.status(403).json({error:'proposals_disabled'});
    const b=req.method==='GET'?req.query:typeof req.body==='string'?JSON.parse(req.body):req.body||{};
    if(JSON.stringify(b).length>180000)throw new TrackerError('too_large','The proposal is too large.',413);
    const op=String(b.op||'workspace');
    if(req.method!=='GET'){
      if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
      if(!csrfOk(req))return res.status(403).json({error:'csrf_check_failed'});
      if(!canCreateClientDoc(user.role))return res.status(403).json({error:'forbidden'});
    }
    const result=await database.transaction(async db=>{
      if(op==='latest_draft'){
        if(req.method!=='GET')throw new TrackerError('method_not_allowed','Use GET to read saved drafts.',405);
        const saved=(await db.query("SELECT draft_key AS key FROM proposal_autosaves WHERE tenant_id=$1 AND user_id=$2 AND (draft_key='new' OR draft_key LIKE 'new:%') ORDER BY updated_at DESC,draft_key DESC LIMIT 1",[user.tenantId,user.id])).rows[0];
        return saved||{key:null};
      }
      if(op==='autosave'){
        const key=String(b.key||'new').slice(0,220);
        if(!isNewProposalDraftKey(key))await scopedProposal(db,user,key);
        if(req.method==='GET')return (await db.query('SELECT payload,version,updated_at FROM proposal_autosaves WHERE tenant_id=$1 AND user_id=$2 AND draft_key=$3',[user.tenantId,user.id,key])).rows[0]||{payload:null,version:0};
        if(b.clear){
          const saved=(await db.query('SELECT version FROM proposal_autosaves WHERE tenant_id=$1 AND user_id=$2 AND draft_key=$3 FOR UPDATE',[user.tenantId,user.id,key])).rows[0];
          if(saved&&saved.version!==Number(b.version))throw new TrackerError('draft_conflict','This draft changed in another tab. Your newer draft has been preserved.',409);
          await db.query('DELETE FROM proposal_autosaves WHERE tenant_id=$1 AND user_id=$2 AND draft_key=$3',[user.tenantId,user.id,key]);return {ok:true};
        }
        const r=await db.query(`INSERT INTO proposal_autosaves(tenant_id,user_id,draft_key,payload,version) SELECT $1,$2,$3,$4::jsonb,1 WHERE $5::integer=0 ON CONFLICT DO NOTHING RETURNING version`,[user.tenantId,user.id,key,JSON.stringify(b.payload||{}),Number(b.version)||0]);
        if(r.rows.length)return r.rows[0];
        const updated=await db.query('UPDATE proposal_autosaves SET payload=$4::jsonb,version=version+1,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND draft_key=$3 AND version=$5 RETURNING version',[user.tenantId,user.id,key,JSON.stringify(b.payload||{}),Number(b.version)||0]);
        if(!updated.rows.length)throw new TrackerError('draft_conflict','This draft changed in another tab. Reload to use the latest saved draft.',409);
        return updated.rows[0];
      }
      if(op==='policy'){
        if(!canSeeCosts(user))throw new TrackerError('forbidden','Only an administrator can manage proposal policies.',403);
        if(req.method==='GET')return {policy:(await db.query('SELECT policy FROM proposal_policies WHERE tenant_id=$1',[user.tenantId])).rows[0]?.policy||{requireAll:false,customTerms:false,thresholdMinor:''}};
        const p=b.policy||{};if(p.thresholdMinor&&!/^\d{1,18}$/.test(String(p.thresholdMinor)))throw new TrackerError('invalid_price','Enter a valid approval threshold.');
        const policy={requireAll:!!p.requireAll,customTerms:!!p.customTerms,thresholdMinor:String(p.thresholdMinor||'')};
        await db.query('INSERT INTO proposal_policies(tenant_id,policy) VALUES($1,$2::jsonb) ON CONFLICT(tenant_id) DO UPDATE SET policy=excluded.policy',[user.tenantId,JSON.stringify(policy)]);return {policy};
      }
      if(op==='product_policy'){
        admin(user);const product=(await db.query('SELECT id FROM products WHERE tenant_id=$1 AND id=$2',[user.tenantId,String(b.productId)])).rows[0];if(!product)throw new TrackerError('not_found','Product not found.',404);
        if(req.method==='GET')return {policy:(await db.query('SELECT policy FROM proposal_product_policies WHERE tenant_id=$1 AND product_id=$2',[user.tenantId,product.id])).rows[0]?.policy||null};
        const policy=normalizeProductPolicy(b.policy);
        for(const dependency of [policy.requiresProductId,policy.includedFromProductId].filter(Boolean)){
          if(dependency===product.id||!(await db.query('SELECT 1 FROM products WHERE tenant_id=$1 AND id=$2',[user.tenantId,dependency])).rows.length)throw new TrackerError('invalid_dependency','Choose another product from this workspace.');
        }
        await db.query('INSERT INTO proposal_product_policies(tenant_id,product_id,policy) VALUES($1,$2,$3::jsonb) ON CONFLICT(tenant_id,product_id) DO UPDATE SET policy=excluded.policy,updated_at=now()',[user.tenantId,product.id,JSON.stringify(policy)]);return {ok:true,policy};
      }
      const row=await scopedProposal(db,user,String(b.id),req.method!=='GET');const ws=await workspaceFor(db,row);
      if(req.method==='GET')return workspaceResponse(db,user,row);
      if(op==='options'){
        if(row.status!=='draft'||row.ghl_invoice_id)throw new TrackerError('document_locked','Create a revision to change a shared proposal.',409);
        const options=await normalizeOptions(db,user,row,b.options);
        const r=await db.query("UPDATE proposal_workspaces SET options=$3::jsonb,version=version+1,approval_status='not_requested',approval_hash=NULL,updated_at=now() WHERE tenant_id=$1 AND document_id=$2 AND version=$4 RETURNING version",[user.tenantId,row.id,JSON.stringify(options),Number(b.version)]);
        if(!r.rows.length)throw new TrackerError('draft_conflict','Proposal settings changed in another tab. Reload before saving.',409);
        await suiteEvent(db,row,'settings_updated',user.name,'Proposal options saved.');return r.rows[0];
      }
      if(op==='request_approval'){
        if(row.status!=='draft')throw new TrackerError('document_locked','Only drafts can request internal approval.',409);
        await db.query("UPDATE proposal_workspaces SET approval_status='pending',approval_hash=$3,requested_by=$4,reviewed_by=NULL,review_note=NULL,reviewed_at=NULL WHERE tenant_id=$1 AND document_id=$2",[user.tenantId,row.id,documentFingerprint(row,ws.options),user.id]);
        await suiteEvent(db,row,'approval_requested',user.name);return {ok:true};
      }
      if(op==='review'){
        if(!canReview(user))throw new TrackerError('forbidden','A manager or administrator must review this proposal.',403);
        if(ws.requested_by===user.id)throw new TrackerError('separate_reviewer','Another manager or administrator must review your request.',403);
        const state=await approvalState(db,row,ws);if(state.status!=='pending'||row.status!=='draft')throw new TrackerError('review_stale','The proposal changed. Request a new review.',409);
        const status=b.approved?'approved':'rejected',note=String(b.note||'').trim().slice(0,2000);if(!note)throw new TrackerError('note_required','Add a review note.');
        await db.query('UPDATE proposal_workspaces SET approval_status=$3,reviewed_by=$4,review_note=$5,reviewed_at=now() WHERE tenant_id=$1 AND document_id=$2',[user.tenantId,row.id,status,user.id,note]);await suiteEvent(db,row,`internally_${status}`,user.name,note);return {ok:true};
      }
      if(op==='followup'){const date=String(b.date||'');if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))throw new TrackerError('invalid_date','Enter a follow-up date.');await db.query('UPDATE proposal_workspaces SET options=options||$3::jsonb,version=version+1 WHERE tenant_id=$1 AND document_id=$2',[user.tenantId,row.id,JSON.stringify({followUpDate:date})]);await suiteEvent(db,row,'followup_scheduled',user.name,date||'Follow-up cleared');return {ok:true};}
      if(op==='message')return addProposalMessage(db,row,b,user.name,'team');
      if(op==='task'){
        if(!['todo','doing','done'].includes(b.status))throw new TrackerError('invalid_status','Choose a valid task status.');
        const r=await db.query('UPDATE proposal_handover_tasks SET status=$4,completed_at=CASE WHEN $4=\'done\' THEN now() ELSE NULL END WHERE tenant_id=$1 AND document_id=$2 AND id=$3 RETURNING id',[user.tenantId,row.id,String(b.taskId),b.status]);if(!r.rows.length)throw new TrackerError('not_found','Task not found.',404);
        await suiteEvent(db,row,'task_updated',user.name,`Onboarding task marked ${b.status}.`);return {ok:true};
      }
      if(op==='revision'){
        const kind=['revision','renewal','expansion'].includes(b.kind)?b.kind:'revision';
        if(kind!=='revision'&&row.status!=='signed')throw new TrackerError('approval_required','Start a renewal or expansion from an approved proposal.',409);
        const newId=id('doc');
        await db.query(`INSERT INTO documents(id,tenant_id,kind,title,client_id,salesperson_id,template_id,body,sections,style,status,amount,created_by_user_id,prospect,line_items,campaign_id) SELECT $3,tenant_id,kind,title||$4,COALESCE(client_id,created_client_id),salesperson_id,template_id,body,sections,style,'draft',amount,$5,prospect,line_items,campaign_id FROM documents WHERE tenant_id=$1 AND id=$2`,[user.tenantId,row.id,newId,` — ${kind}`,user.id]);
        const options={...emptyProposalOptions(),...ws.options,packages:[],selectedPackageId:undefined,approvalNote:'',effectiveDate:'',deliveryDate:'',followUpDate:'',renewalDate:''};
        await db.query('INSERT INTO proposal_workspaces(document_id,tenant_id,parent_id,revision_kind,options) VALUES($1,$2,$3,$4,$5::jsonb)',[newId,user.tenantId,ws.parent_id||row.id,kind,JSON.stringify(options)]);
        await suiteEvent(db,row,`${kind}_created`,user.name,'A separate draft was created; this agreement is unchanged.');
        await suiteEvent(db,{id:newId,tenant_id:user.tenantId},'draft_created',user.name,`Created from ${row.title}. Review current product pricing before sharing.`);return {id:newId};
      }
      throw new TrackerError('invalid_operation','Unknown proposal action.');
    });
    return res.json(result);
  }catch(e){if(e instanceof TrackerError)return res.status(e.status).json({error:e.code,message:e.message});console.error('[proposal-workspace]',e instanceof Error?e.message:e);return res.status(500).json({error:'internal_error',message:'The proposal workspace could not be loaded. Try again.'});}
}
