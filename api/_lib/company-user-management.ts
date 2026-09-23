import {ROLES,type SessionUser} from './auth.js';
import {admin,audit,id,lock,required,TrackerError,type SQL} from './tracker-common.js';
import {enroll,saveParticipant} from './tracker-people.js';

async function actor(db:SQL,u:SessionUser){
  admin(u);await lock(db,u.tenantId);
  const current=(await db.query("SELECT role,status FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[u.tenantId,u.id])).rows[0];
  if(!current||current.status!=='active'||!['owner','admin'].includes(current.role))throw new TrackerError('forbidden','An active administrator must make this change.',403);
  return {...u,role:current.role} as SessionUser;
}
async function target(db:SQL,u:SessionUser,b:any){
  if(b.userId){const row=(await db.query('SELECT * FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[u.tenantId,b.userId])).rows[0];if(!row)throw new TrackerError('not_found','User not found in this company.',404);return row;}
  const external=(await db.query("SELECT * FROM external_users WHERE tenant_id=$1 AND provider='ghl' AND external_id=$2 AND active=true",[u.tenantId,required(b.externalId,'Connected user')])).rows[0];
  if(!external)throw new TrackerError('not_found','Choose an active Kleeger user in this company.',404);
  const linked=(await db.query('SELECT * FROM users WHERE tenant_id=$1 AND kleegr_user_id=$2 FOR UPDATE',[u.tenantId,external.external_id])).rows;
  if(linked.length>1)throw new TrackerError('ambiguous_user','Multiple logins are linked to this user. Review them before changing access.',409);
  if(linked[0])return linked[0];
  const email=String(external.email||'').trim().toLowerCase();
  if(!email)throw new TrackerError('email_required','Add an email to this Kleeger user before granting app access.');
  if((await db.query('SELECT id FROM users WHERE tenant_id=$1 AND lower(trim(email))=$2',[u.tenantId,email])).rows.length)throw new TrackerError('existing_login','This email already has an app login. Change the role on that login instead.',409);
  return {id:null,tenant_id:u.tenantId,name:external.name,email,kleegr_user_id:external.external_id,role:null,status:null,salesperson_id:null};
}
async function enrollment(db:SQL,u:SessionUser,person:any,role='salesperson'){
  let sp=person.salesperson_id?(await db.query('SELECT * FROM salespeople WHERE tenant_id=$1 AND id=$2',[u.tenantId,person.salesperson_id])).rows[0]:null;
  if(!sp&&person.kleegr_user_id){const result=await enroll(db,u,{externalIds:[person.kleegr_user_id],role});sp=(await db.query('SELECT * FROM salespeople WHERE tenant_id=$1 AND id=$2',[u.tenantId,result.ids[0]])).rows[0];}
  if(!sp){const matches=(await db.query("SELECT * FROM salespeople WHERE tenant_id=$1 AND lower(trim(email))=$2 AND ghl_user_id IS NULL",[u.tenantId,person.email.trim().toLowerCase()])).rows;if(matches.length>1)throw new TrackerError('ambiguous_salesman','Multiple salesmen share this email. Link the correct profile first.',409);sp=matches[0];}
  const saved=await saveParticipant(db,u,{id:sp?.id,name:person.name,email:person.email,role,status:'active',teamId:sp?.team_id,parentId:sp?.parent_salesperson_id});
  if(person.id)await db.query('UPDATE users SET salesperson_id=$3 WHERE tenant_id=$1 AND id=$2',[u.tenantId,person.id,saved.id]);
  return saved.id;
}
export async function enrollCompanyUser(db:SQL,session:SessionUser,b:any){
  const u=await actor(db,session),person=await target(db,u,b);
  const salespersonId=await enrollment(db,u,person);
  await audit(db,u,'salesperson',salespersonId,'enrolled_from_users',{userId:person.id,externalId:person.kleegr_user_id});
  return {salespersonId};
}
export async function changeCompanyUserRole(db:SQL,session:SessionUser,b:any){
  const u=await actor(db,session),person=await target(db,u,b),role=String(b.role||'');
  if(![...ROLES,'none'].includes(role))throw new TrackerError('invalid_role','Choose a supported app role.');
  if(person.id===u.id)throw new TrackerError('self_role_change','Ask another administrator to change your own access.',409);
  if((role==='owner'||person.role==='owner')&&u.role!=='owner')throw new TrackerError('owner_required','Only an owner can assign or change Owner access.',403);
  if((person.role||'none')!==b.expectedRole||(person.status||'none')!==b.expectedStatus)throw new TrackerError('user_changed','This user changed since you opened the form. Refresh and try again.',409);
  const reason=required(b.reason,'Reason for role change',1000);
  if(person.role==='owner'&&person.status==='active'&&role!=='owner'&&!(await db.query("SELECT id FROM users WHERE tenant_id=$1 AND id<>$2 AND role='owner' AND status='active'",[u.tenantId,person.id])).rows.length)throw new TrackerError('last_owner','Keep at least one active owner.',409);
  if(['owner','admin'].includes(person.role)&&person.status==='active'&&!['owner','admin'].includes(role)&&!(await db.query("SELECT id FROM users WHERE tenant_id=$1 AND id<>$2 AND role IN ('owner','admin') AND status='active'",[u.tenantId,person.id])).rows.length)throw new TrackerError('last_admin','Keep at least one active administrator.',409);
  if(!person.id){
    if(role==='none')throw new TrackerError('no_access','This user does not have app access.');
    person.id=id('user');
    await db.query("INSERT INTO users(id,tenant_id,name,email,role,status,kleegr_user_id,role_managed_locally) VALUES($1,$2,$3,$4,$5,'active',$6,true)",[person.id,u.tenantId,person.name,person.email,role,person.kleegr_user_id]);
  }
  if(['salesperson','affiliate','partner'].includes(role))await enrollment(db,u,person,role);
  await db.query("UPDATE users SET role=CASE WHEN $3='none' THEN role ELSE $3 END,status=CASE WHEN $3='none' THEN 'inactive' ELSE 'active' END,role_managed_locally=true,updated_at=now() WHERE tenant_id=$1 AND id=$2",[u.tenantId,person.id,role]);
  await db.query('DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2',[u.tenantId,person.id]);
  await audit(db,u,'user',person.id,'app_role_changed',{previousRole:person.role,previousStatus:person.status,role,reason});
  return {id:person.id,role,status:role==='none'?'inactive':'active'};
}
