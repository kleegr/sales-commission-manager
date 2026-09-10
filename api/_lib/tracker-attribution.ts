import {validateCampaignSource} from './campaign-sources.js';
import {createHash,randomBytes} from 'node:crypto';
import type {SessionUser} from './auth.js';
import {admin,audit,client,dateOnly,id,lock,participant,required,TrackerError,workspace,type SQL} from './tracker-common.js';
import {minor} from '../../src/lib/exact-commission.js';

export function safeDestination(value:unknown):string {
  const url=new URL(required(value,'Destination URL',2000));
  if(url.protocol!=='https:'||url.username||url.password||url.hostname==='localhost'||/^(127\.|10\.|192\.168\.|169\.254\.|\[)/.test(url.hostname)||/^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname))throw new TrackerError('invalid_destination','Use a public HTTPS destination without embedded credentials.');
  return url.toString();
}
export async function createLead(db:SQL,u:SessionUser,b:any){
  admin(u);const leadId=id('lead');if(b.ownerId)await participant(db,u,b.ownerId);
  await db.query(`INSERT INTO clients(id,tenant_id,contact_name,email,phone,company_name,salesperson_id,original_source,signup_date,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())`,[leadId,u.tenantId,required(b.name,'Lead name'),String(b.email||'').trim().toLowerCase(),String(b.phone||''),String(b.company||''),b.ownerId||null,required(b.source,'Original source'),dateOnly(b.date)]);
  await audit(db,u,'client',leadId,'lead_created',{source:b.source,ownerId:b.ownerId||null});return{id:leadId};
}
export async function editLead(db:SQL,u:SessionUser,b:any){
  admin(u);const lead=await client(db,u,b.id);if(lead.ghl_contact_id||lead.kleegr_contact_id)throw new TrackerError('provider_owned','Provider contact details must be refreshed from the connection. Attribution is managed separately.');
  const reason=required(b.reason,'Edit reason');await db.query('UPDATE clients SET contact_name=$3,email=$4,phone=$5,company_name=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2',[u.tenantId,lead.id,required(b.name,'Contact name'),String(b.email||'').trim().toLowerCase(),String(b.phone||''),String(b.company||'')]);await audit(db,u,'client',lead.id,'profile_edited',{reason});return{id:lead.id};
}
export async function attributeLead(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const lead=await client(db,u,b.clientId),w=await workspace(db,u),reason=required(b.reason,'Reason'),evidence=required(b.evidence,'Evidence');
  const fields:Record<string,string>={referrer:'referrer_id',owner:'salesperson_id',closer:'closer_id'};const column=fields[b.kind];if(!column)throw new TrackerError('invalid_kind','Choose referrer, owner or closer.');
  if(b.participantId)await participant(db,u,b.participantId);
  await db.query(`UPDATE clients SET ${column}=$3,attribution_method=CASE WHEN $4='referrer' THEN 'manual' ELSE attribution_method END,attribution_evidence=CASE WHEN $4='referrer' THEN $5 ELSE attribution_evidence END,attribution_at=CASE WHEN $4='referrer' THEN now() ELSE attribution_at END,attribution_policy_version=$6,attribution_status=CASE WHEN $4='referrer' THEN CASE WHEN $3::text IS NULL THEN 'unattributed' ELSE 'attributed' END ELSE attribution_status END,updated_at=now() WHERE tenant_id=$1 AND id=$2`,[u.tenantId,lead.id,b.participantId||null,b.kind,evidence,w.attribution_policy.version]);
  await db.query('INSERT INTO attribution_events(id,tenant_id,client_id,kind,previous_id,participant_id,method,evidence,reason,policy_version,actor_id) VALUES($1,$2,$3,$4,$5,$6,\'manual\',$7,$8,$9,$10)',[id('attr'),u.tenantId,lead.id,b.kind,lead[column],b.participantId||null,evidence,reason,w.attribution_policy.version,u.id]);
  if(b.reviewId)await db.query("UPDATE attribution_reviews SET status='resolved',resolved_at=now() WHERE tenant_id=$1 AND id=$2 AND client_id=$3",[u.tenantId,b.reviewId,lead.id]);
  await audit(db,u,'client',lead.id,'attribution_changed',{kind:b.kind,previous:lead[column],participantId:b.participantId||null,reason,evidence,historicalEarningsChanged:0});return{id:lead.id};
}
export async function attributionCandidate(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const lead=await client(db,u,b.clientId),w=await workspace(db,u),policy=w.attribution_policy;
  if(!['referral_code','field_mapping'].includes(b.method))throw new TrackerError('invalid_method','Choose a local referral code or an allowed provider field.');
  let code='';
  if(b.method==='field_mapping'){
    if(!Array.isArray(policy.fieldIds)||!policy.fieldIds.includes(b.fieldId))throw new TrackerError('field_not_configured','An administrator must configure this GHL field in the attribution policy first.');
    code=String(lead.provider_attribution_fields?.[b.fieldId]||'');
  }else code=required(b.code,'Referral code',200);
  const matches=(await db.query("SELECT id FROM salespeople WHERE tenant_id=$1 AND referral_code=$2 AND referral_code<>'' AND status='active'",[u.tenantId,code])).rows;
  if(matches.length!==1)throw new TrackerError('unresolved_code','This value does not uniquely identify an active local participant. No attribution was changed.');
  const candidate=matches[0].id,evidence=b.method==='field_mapping'?`GHL field ${b.fieldId}: ${code}`:`Verified local referral code: ${code}`;
  const hasPrior=!!lead.referrer_id&&lead.referrer_id!==candidate;
  const age=lead.attribution_at?Date.now()-new Date(lead.attribution_at).getTime():0;
  const precedence=policy.evidencePriority==='field_first'?['field_mapping','referral_code']:['referral_code','field_mapping'];const mayReplace=lead.attribution_method!=='manual'&&lead.attribution_method!=='referral_link'&&age<=Number(policy.windowDays||30)*86400000&&(precedence.indexOf(b.method)<precedence.indexOf(lead.attribution_method)||(policy.touch==='last'&&b.method===lead.attribution_method));
  if(hasPrior&&!mayReplace){const reviewId=id('review');await db.query('INSERT INTO attribution_reviews(id,tenant_id,client_id,candidate_id,method,evidence,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',[reviewId,u.tenantId,lead.id,candidate,b.method,evidence,'Conflicting source or protected attribution. Review evidence before overriding.']);await audit(db,u,'attribution_review',reviewId,'candidate_queued',{clientId:lead.id,candidate,method:b.method});return{reviewRequired:true,id:reviewId};}
  if(lead.referrer_id===candidate)return{duplicate:true};
  await db.query("UPDATE clients SET referrer_id=$3,original_source=COALESCE(original_source,$4),attribution_method=$4,attribution_evidence=$5,attribution_at=now(),attribution_policy_version=$6,attribution_status='attributed' WHERE tenant_id=$1 AND id=$2",[u.tenantId,lead.id,candidate,b.method,evidence,policy.version]);
  await db.query('INSERT INTO attribution_events(id,tenant_id,client_id,kind,previous_id,participant_id,method,evidence,reason,policy_version,actor_id) VALUES($1,$2,$3,\'referrer\',$4,$5,$6,$7,$8,$9,$10)',[id('attr'),u.tenantId,lead.id,lead.referrer_id,candidate,b.method,evidence,`Applied ${policy.touch||'first'} touch policy; recorded earnings unchanged`,policy.version,u.id]);
  await audit(db,u,'client',lead.id,'candidate_attributed',{candidate,method:b.method,policyVersion:policy.version});return{id:lead.id};
}
export async function saveOpportunity(db:SQL,u:SessionUser,b:any){
  admin(u);const configured=await workspace(db,u);if(b.currency!==configured.currency)throw new TrackerError('currency_mismatch','Use the configured workspace currency for opportunity values.');const lead=await client(db,u,b.clientId);if(b.ownerId)await participant(db,u,b.ownerId);if(b.closerId)await participant(db,u,b.closerId);
  if(!['open','won','lost','abandoned'].includes(b.status)||minor(b.valueMinor)<0n||!/^[A-Z]{3}$/.test(b.currency))throw new TrackerError('invalid_opportunity','Check opportunity status, amount and currency.');
  const opportunityId=b.id||id('opp');
  if(b.id){const old=(await db.query('SELECT * FROM opportunities WHERE tenant_id=$1 AND id=$2',[u.tenantId,b.id])).rows[0];if(!old||old.source!=='manual')throw new TrackerError('provider_owned','Only local opportunities may be edited here. Provider changes must be synchronized.');}
  await db.query(`INSERT INTO opportunities(id,tenant_id,client_id,name,pipeline_id,stage_id,owner_id,closer_id,value_minor,currency,status,won_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11='won' THEN now() ELSE NULL END) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,pipeline_id=EXCLUDED.pipeline_id,stage_id=EXCLUDED.stage_id,owner_id=EXCLUDED.owner_id,closer_id=EXCLUDED.closer_id,value_minor=EXCLUDED.value_minor,status=EXCLUDED.status,won_at=COALESCE(opportunities.won_at,EXCLUDED.won_at),updated_at=now() WHERE opportunities.tenant_id=EXCLUDED.tenant_id`,[opportunityId,u.tenantId,lead.id,required(b.name,'Opportunity name'),b.pipelineId||null,b.stageId||null,b.ownerId||null,b.closerId||null,b.valueMinor,b.currency,b.status]);
  await audit(db,u,'opportunity',opportunityId,'saved',{status:b.status,valueMinor:b.valueMinor,commissionGenerated:false});return{id:opportunityId};
}
export async function saveCampaign(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const campaignId=b.id||id('campaign');if(b.id&&!(await db.query('SELECT id FROM campaigns WHERE tenant_id=$1 AND id=$2',[u.tenantId,b.id])).rows[0])throw new TrackerError('not_found','Campaign not found.',404);
  if(!['draft','active','paused','completed','archived'].includes(b.status)||!['native','external'].includes(b.conversionMode))throw new TrackerError('invalid_campaign','Choose a valid campaign lifecycle and conversion mode.');
  const start=b.startsAt?dateOnly(b.startsAt):null,end=b.endsAt?dateOnly(b.endsAt):null;if(start&&end&&end<start)throw new TrackerError('invalid_dates','Campaign end must follow its start.');
  const window=Number(b.windowDays);if(!Number.isInteger(window)||window<1||window>365)throw new TrackerError('invalid_window','Referral window must be 1–365 days.');
  if(b.versionId && !(await db.query('SELECT id FROM plan_versions WHERE tenant_id=$1 AND id=$2',[u.tenantId,b.versionId])).rows[0])throw new TrackerError('invalid_version','Plan version not found.');
  if(['test','live'].includes(b.automation)&&!b.source?.selection?.checkout?.products?.length)throw new TrackerError('checkout_required','Load a published checkout with eligible products before enabling automatic commissions.');
  const destination=b.conversionMode==='external'?safeDestination(b.destinationUrl):null;
  await db.query(`INSERT INTO campaigns(id,tenant_id,name,description,status,starts_at,ends_at,destination_url,conversion_mode,plan_version_id,tracking_policy,terms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,status=EXCLUDED.status,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,destination_url=EXCLUDED.destination_url,conversion_mode=EXCLUDED.conversion_mode,plan_version_id=EXCLUDED.plan_version_id,tracking_policy=EXCLUDED.tracking_policy,terms=EXCLUDED.terms,verification_status=CASE WHEN campaigns.destination_url IS DISTINCT FROM EXCLUDED.destination_url OR campaigns.conversion_mode<>EXCLUDED.conversion_mode THEN 'configured' ELSE campaigns.verification_status END WHERE campaigns.tenant_id=EXCLUDED.tenant_id`,[campaignId,u.tenantId,required(b.name,'Campaign name'),String(b.description||''),b.status,start,end,destination,b.conversionMode,b.versionId||null,JSON.stringify({windowDays:window,touch:b.touch==='last'?'last':'first',source:validateCampaignSource(u.tenantId,b,destination),automation:['test','live'].includes(b.automation)?b.automation:'off'}),String(b.terms||'')]);
  if(!Array.isArray(b.participantIds)||b.participantIds.length>1000)throw new TrackerError('invalid_participants','Select campaign participants.');
  for(const spId of new Set<string>(b.participantIds)){const sp=await participant(db,u,spId);if(sp.status!=='active')throw new TrackerError('inactive_participant','Campaign participants must be active.');await db.query(`INSERT INTO campaign_participants(tenant_id,campaign_id,salesperson_id,link_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,campaign_id,salesperson_id) DO UPDATE SET active=true`,[u.tenantId,campaignId,spId,randomBytes(24).toString('base64url')]);}
  await db.query('UPDATE campaign_participants SET active=false WHERE tenant_id=$1 AND campaign_id=$2 AND NOT(salesperson_id=ANY($3::text[]))',[u.tenantId,campaignId,b.participantIds]);
  await audit(db,u,'campaign',campaignId,'saved',{status:b.status,participants:b.participantIds,mode:b.conversionMode});return{id:campaignId};
}
export async function referralClick(db:SQL,code:string){
  const c=(await db.query(`SELECT c.*,p.salesperson_id,p.link_id FROM campaign_participants p JOIN campaigns c ON c.tenant_id=p.tenant_id AND c.id=p.campaign_id JOIN salespeople s ON s.tenant_id=p.tenant_id AND s.id=p.salesperson_id WHERE p.link_id=$1 AND p.active=true AND s.status='active' AND c.status='active' AND (c.starts_at IS NULL OR c.starts_at<=CURRENT_DATE) AND (c.ends_at IS NULL OR c.ends_at>=CURRENT_DATE)`,[code])).rows[0];if(!c)throw new TrackerError('link_unavailable','This referral link is not active.',404);
  const clickId=randomBytes(32).toString('base64url');const days=Number(c.tracking_policy.windowDays)||30;
  await lock(db,c.tenant_id);
  if(Number((await db.query("SELECT count(*)::text AS n FROM referral_clicks WHERE link_id=$1 AND created_at>now()-interval '1 minute'",[code])).rows[0].n)>=100)throw new TrackerError('rate_limited','This referral link is busy. Please retry shortly.',429);
  await db.query("INSERT INTO referral_clicks(id,tenant_id,campaign_id,salesperson_id,link_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+($6||' days')::interval)",[clickId,c.tenant_id,c.id,c.salesperson_id,c.link_id,String(days)]);
  const destination=c.destination_url?new URL(safeDestination(c.destination_url)):null;if(destination)destination.searchParams.set('referralClick',clickId);
  return{clickId,name:c.name,terms:c.terms,mode:c.conversion_mode,destination:destination?.toString()||null};
}
export async function convertReferral(db:SQL,b:any){
  if(b.consent!==true)throw new TrackerError('consent_required','Consent is required before submitting contact details.');
  const clickId=required(b.clickId,'Referral click',100);
  const click=(await db.query(`SELECT k.*,c.conversion_mode,c.status,c.tracking_policy,c.ends_at FROM referral_clicks k JOIN campaigns c ON c.tenant_id=k.tenant_id AND c.id=k.campaign_id WHERE k.id=$1 AND k.expires_at>now() AND c.status='active' AND (c.ends_at IS NULL OR c.ends_at>=CURRENT_DATE)`,[clickId])).rows[0];
  if(!click||click.conversion_mode!=='native')throw new TrackerError('conversion_unavailable','This native conversion link is not available.',409);
  await lock(db,click.tenant_id);
  if((await db.query('SELECT id FROM referral_conversions WHERE tenant_id=$1 AND click_id=$2',[click.tenant_id,clickId])).rows.length)return{accepted:true};
  const email=required(b.email,'Email',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new TrackerError('invalid_email','Enter a valid email.');
  const dedupe=createHash('sha256').update(email).digest('hex');
  const previous=(await db.query('SELECT * FROM referral_conversions WHERE tenant_id=$1 AND campaign_id=$2 AND dedupe_key=$3',[click.tenant_id,click.campaign_id,dedupe])).rows[0];
  if(previous){if(previous.click_id!==clickId){await db.query("INSERT INTO attribution_reviews(id,tenant_id,client_id,candidate_id,method,evidence,reason) VALUES($1,$2,$3,$4,'referral_link',$5,'A different referral link claimed an existing conversion; review before changing attribution.')",[id('review'),click.tenant_id,previous.client_id,click.salesperson_id,clickId]);}return{accepted:true};}
  const leadId=id('lead'),conversionId=id('conversion');
  await db.query(`INSERT INTO clients(id,tenant_id,contact_name,email,phone,original_source,referrer_id,campaign_id,attribution_method,attribution_evidence,attribution_at,attribution_status,attribution_policy_version,signup_date,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'referral_link',$6,$7,'referral_link',$8,now(),'attributed',1,CURRENT_DATE,now(),now())`,[leadId,click.tenant_id,required(b.name,'Name',200),email,String(b.phone||'').slice(0,50),click.salesperson_id,click.campaign_id,clickId]);
  await db.query("INSERT INTO referral_conversions(id,tenant_id,campaign_id,click_id,client_id,dedupe_key,source,consent_at) VALUES($1,$2,$3,$4,$5,$6,'native',now())",[conversionId,click.tenant_id,click.campaign_id,clickId,leadId,dedupe]);
  await db.query("INSERT INTO attribution_events(id,tenant_id,client_id,kind,participant_id,method,evidence,reason,policy_version) VALUES($1,$2,$3,'referrer',$4,'referral_link',$5,'Consented native referral conversion',1)",[id('attr'),click.tenant_id,leadId,click.salesperson_id,clickId]);
  await db.query("UPDATE campaigns SET verification_status='verified_native' WHERE tenant_id=$1 AND id=$2",[click.tenant_id,click.campaign_id]);
  await db.query('UPDATE tenants SET data_revision=data_revision+1 WHERE id=$1',[click.tenant_id]);return{accepted:true};
}
