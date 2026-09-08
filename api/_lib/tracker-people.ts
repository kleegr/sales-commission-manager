import type { SessionUser } from './auth.js';
import {admin,audit,dateOnly,id,lock,participant,required,TrackerError,type SQL} from './tracker-common.js';
import {validatePlan,type ExactPlan} from '../../src/lib/exact-commission.js';

export async function enroll(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);
  if(!Array.isArray(b.externalIds)||!b.externalIds.length||b.externalIds.length>100)throw new TrackerError('invalid_selection','Select 1–100 available users.');
  if(!['salesperson','affiliate','partner'].includes(b.role))throw new TrackerError('invalid_role','Choose a commission participant role. This does not grant app access.');
  const result:string[]=[];
  for(const externalId of new Set<string>(b.externalIds)){
    const e=(await db.query("SELECT * FROM external_users WHERE tenant_id=$1 AND provider='ghl' AND external_id=$2 AND active=true",[u.tenantId,externalId])).rows[0];
    if(!e)throw new TrackerError('not_available','A selected user is not active in this workspace.',409);
    const existing=(await db.query('SELECT id FROM salespeople WHERE tenant_id=$1 AND (ghl_user_id=$2 OR kleegr_user_id=$2)',[u.tenantId,externalId])).rows[0];
    if(existing){result.push(existing.id);continue;}
    const sp=id('sp');await db.query(`INSERT INTO salespeople(id,tenant_id,name,email,phone,role,ghl_user_id,ghl_role,ghl_active,ghl_synced_at,enrolled_at,enrolled_by,referral_code,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,now(),now(),$9,$10,now(),now())`,[sp,u.tenantId,e.name,e.email,e.phone,b.role,externalId,e.provider_role,u.id,id('ref')]);
    // Only stable provider identity may link an existing login. Import/enrollment never creates one.
    await db.query('UPDATE users SET salesperson_id=$1 WHERE tenant_id=$2 AND kleegr_user_id=$3 AND salesperson_id IS NULL',[sp,u.tenantId,externalId]);
    await audit(db,u,'salesperson',sp,'enrolled',{externalId,role:b.role});result.push(sp);
  }
  return {ids:result};
}
export async function saveParticipant(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const sp=b.id?await participant(db,u,b.id):null;const spId=sp?.id||id('sp');
  if(!['salesperson','affiliate','partner'].includes(b.role)||!['active','inactive'].includes(b.status))throw new TrackerError('invalid_participant','Choose a valid participant role and status.');
  if(b.teamId){const t=(await db.query('SELECT * FROM teams WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',[u.tenantId,b.teamId])).rows[0];if(!t)throw new TrackerError('invalid_team','Team is not available in this workspace.');}
  if(b.parentId){let cursor=b.parentId;const seen=new Set([spId]);while(cursor){if(seen.has(cursor))throw new TrackerError('cycle','Participant hierarchy cannot contain cycles.');seen.add(cursor);cursor=(await participant(db,u,cursor)).parent_salesperson_id;}}
  const name=required(b.name,'Name'),email=typeof b.email==='string'?b.email.trim():'';
  if(sp)await db.query(`UPDATE salespeople SET role=$3,status=$4,team_id=$5,parent_salesperson_id=$6,manager_user_id=(SELECT manager_user_id FROM teams WHERE tenant_id=$1 AND id=$5),updated_at=now(),name=CASE WHEN ghl_user_id IS NULL THEN $7 ELSE name END,email=CASE WHEN ghl_user_id IS NULL THEN $8 ELSE email END WHERE tenant_id=$1 AND id=$2`,[u.tenantId,spId,b.role,b.status,b.teamId||null,b.parentId||null,name,email]);
  else await db.query(`INSERT INTO salespeople(id,tenant_id,name,email,role,status,team_id,parent_salesperson_id,manager_user_id,enrolled_at,enrolled_by,referral_code,source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,(SELECT manager_user_id FROM teams WHERE tenant_id=$2 AND id=$7),now(),$9,$10,'external',now(),now())`,[spId,u.tenantId,name,email,b.role,b.status,b.teamId||null,b.parentId||null,u.id,id('ref')]);
  await audit(db,u,'salesperson',spId,sp?'participant_updated':'external_participant_enrolled',{role:b.role,status:b.status,teamId:b.teamId||null});return{id:spId};
}
export async function saveTeam(db:SQL,u:SessionUser,b:any){
  admin(u);const teamId=b.id||id('team');if(b.id&&!(await db.query('SELECT id FROM teams WHERE tenant_id=$1 AND id=$2',[u.tenantId,b.id])).rows[0])throw new TrackerError('not_found','Team not found.',404);
  if(b.managerId && !(await db.query("SELECT id FROM users WHERE tenant_id=$1 AND id=$2 AND role='sales_manager' AND status='active'",[u.tenantId,b.managerId])).rows[0])throw new TrackerError('invalid_manager','Select an existing active manager login in this workspace.');
  await db.query(`INSERT INTO teams(id,tenant_id,name,manager_user_id) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,manager_user_id=EXCLUDED.manager_user_id WHERE teams.tenant_id=EXCLUDED.tenant_id`,[teamId,u.tenantId,required(b.name,'Team name'),b.managerId||null]);
  await db.query('UPDATE salespeople SET manager_user_id=$3 WHERE tenant_id=$1 AND team_id=$2',[u.tenantId,teamId,b.managerId||null]);
  await audit(db,u,'team',teamId,'saved',{managerId:b.managerId||null});return{id:teamId};
}
export async function publishPlan(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const config=b.config as ExactPlan;validatePlan(config);const w=(await db.query('SELECT currency,payout_terms FROM tracker_workspaces WHERE tenant_id=$1',[u.tenantId])).rows[0];if(!w||w.currency!==config.currency||Number(w.payout_terms.minorDigits??2)!==config.minorDigits)throw new TrackerError('workspace_currency_mismatch','Confirm workspace currency and decimal precision before publishing this plan.');const effective=dateOnly(b.effectiveFrom);
  const planId=b.planId||id('plan');
  if(b.planId && !(await db.query('SELECT id FROM commission_plans WHERE tenant_id=$1 AND id=$2',[u.tenantId,b.planId])).rows[0])throw new TrackerError('not_found','Plan not found.',404);
  const versions=(await db.query('SELECT id,version,effective_from FROM plan_versions WHERE tenant_id=$1 AND plan_id=$2 ORDER BY version DESC',[u.tenantId,planId])).rows;
  if(versions[0] && effective <= new Date(versions[0].effective_from).toISOString().slice(0,10))throw new TrackerError('invalid_effective_date','A new version must start after the preceding version.');
  if(b.preview){const affected=await db.query('SELECT count(DISTINCT salesperson_id)::text AS participants FROM plan_assignments WHERE tenant_id=$1 AND plan_version_id=ANY($2::text[])',[u.tenantId,versions.map(v=>v.id)]);return{existingVersions:versions.length,participants:affected.rows[0].participants,historicalEarningsChanged:0,requiresNewAssignment:true};}
  if(!b.planId)await db.query('INSERT INTO commission_plans(id,tenant_id,name,description,created_at,updated_at) VALUES($1,$2,$3,$4,now(),now())',[planId,u.tenantId,required(b.name,'Plan name'),String(b.description||'')]);
  const versionId=id('pv'),version=(versions[0]?.version||0)+1;
  await db.query('INSERT INTO plan_versions(id,tenant_id,plan_id,version,effective_from,config,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[versionId,u.tenantId,planId,version,effective,JSON.stringify(config),u.id]);
  await audit(db,u,'plan_version',versionId,'published',{planId,version,effectiveFrom:effective});return{id:versionId,planId,version};
}
export async function assignPlan(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);await participant(db,u,b.salespersonId);const from=dateOnly(b.effectiveFrom),to=b.effectiveTo?dateOnly(b.effectiveTo):null;
  const version=(await db.query('SELECT * FROM plan_versions WHERE tenant_id=$1 AND id=$2',[u.tenantId,b.versionId])).rows[0];
  if(!version || from<new Date(version.effective_from).toISOString().slice(0,10)||to&&to<from)throw new TrackerError('invalid_assignment','Check the version and effective dates.');
  if(b.campaignId && !(await db.query('SELECT id FROM campaigns WHERE tenant_id=$1 AND id=$2',[u.tenantId,b.campaignId])).rows[0])throw new TrackerError('invalid_campaign','Campaign not found.');
  const conflicts=(await db.query(`SELECT id FROM plan_assignments WHERE tenant_id=$1 AND salesperson_id=$2 AND effective_from<=COALESCE($4::date,'9999-12-31') AND COALESCE(effective_to,'9999-12-31')>=$3::date AND (product_id IS NULL OR $5::text IS NULL OR product_id=$5) AND (campaign_id IS NULL OR $6::text IS NULL OR campaign_id=$6)`,[u.tenantId,b.salespersonId,from,to,b.productId||null,b.campaignId||null])).rows;
  if(conflicts.length)throw new TrackerError('overlapping_assignment','End the previous assignment before starting an overlapping assignment.',409);
  const assignment=id('pa');await db.query('INSERT INTO plan_assignments(id,tenant_id,salesperson_id,plan_version_id,effective_from,effective_to,product_id,campaign_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[assignment,u.tenantId,b.salespersonId,b.versionId,from,to,b.productId||null,b.campaignId||null,u.id]);await audit(db,u,'plan_assignment',assignment,'assigned',b);return{id:assignment};
}
