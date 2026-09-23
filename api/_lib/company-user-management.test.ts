import assert from 'node:assert/strict';
import {SCHEMA_SQL} from './schema.js';
import {MIGRATIONS_SQL} from './migrations.js';
import {TRACKER_SCHEMA_SQL} from './tracker-schema.js';
import {changeCompanyUserRole,enrollCompanyUser} from './company-user-management.js';
import {upsertUserForClaims} from './kleegr-sync.js';
import type {SessionUser} from './auth.js';
const {PGlite}=await import(process.env.PGLITE_TEST_MODULE||'@electric-sql/pglite');
const pg=new PGlite();const db={query:(s:string,p:any[]=[])=>pg.query(s,p)};
const tx=(fn:(db:any)=>Promise<any>)=>pg.transaction((c:any)=>fn({query:(s:string,p:any[]=[])=>c.query(s,p)}));
const owner={id:'owner',tenantId:'a',role:'owner',name:'Owner'} as SessionUser;
const admin={...owner,id:'admin',role:'admin'} as SessionUser;
const change=(u:SessionUser,userId:string,role:string,expectedRole:string,expectedStatus='active')=>tx(db=>changeCompanyUserRole(db,u,{userId,role,expectedRole,expectedStatus,reason:'Reviewed test change'}));
let checks=0;async function check(name:string,fn:()=>Promise<void>){await fn();checks++;console.log(`✓ ${name}`);}
try{
 await pg.exec(SCHEMA_SQL);await pg.exec(MIGRATIONS_SQL);await pg.exec(TRACKER_SCHEMA_SQL);
 await pg.exec("INSERT INTO tenants(id,name,slug) VALUES('a','A','a'),('b','B','b'); INSERT INTO users(id,tenant_id,name,email,role) VALUES('owner','a','Owner','owner@example.test','owner'),('admin','a','Admin','admin@example.test','admin'),('rep','a','Rep','rep@example.test','salesperson'),('other','b','Other','other@example.test','admin'); INSERT INTO external_users(tenant_id,external_id,name,email,provider_role) VALUES('a','connected','Connected User','connected@example.test','user');");
 await check('non-admins, stale admin claims and cross-company targets cannot change roles',async()=>{
  await assert.rejects(change({...owner,id:'rep'},'admin','salesperson','admin'),{code:'forbidden'});
  await assert.rejects(change(admin,'other','salesperson','admin'),{code:'not_found'});
 });
 await check('administrators cannot promote to Owner, change an Owner, or change themselves',async()=>{
  await assert.rejects(change(admin,'rep','owner','salesperson'),{code:'owner_required'});
  await assert.rejects(change(admin,'owner','admin','owner'),{code:'owner_required'});
  await assert.rejects(change(owner,'owner','salesperson','owner'),{code:'self_role_change'});
 });
 await check('stale roles and missing reasons are rejected',async()=>{
  await assert.rejects(change(admin,'rep','admin','partner'),{code:'user_changed'});
  await assert.rejects(tx(db=>changeCompanyUserRole(db,admin,{userId:'rep',role:'admin',expectedRole:'salesperson',expectedStatus:'active'})),{code:'invalid_input'});
 });
 await check('a connected user gets app access without a password or automatic salesman enrollment',async()=>{
  const result=await tx(db=>changeCompanyUserRole(db,admin,{externalId:'connected',role:'admin',expectedRole:'none',expectedStatus:'none',reason:'Manage company'}));
  const user=(await db.query('SELECT * FROM users WHERE id=$1',[result.id])).rows[0];
  assert.equal(user.role,'admin');assert.equal(user.role_managed_locally,true);assert.equal(user.password_hash,null);assert.equal(user.salesperson_id,null);
 });
 const connected=()=>db.query("SELECT * FROM users WHERE tenant_id='a' AND kleegr_user_id='connected'").then((r:any)=>r.rows[0]);
 const claims={sp_user_id:'connected',sub_account_id:'a',location_id:'a',email:'connected@example.test',role:'user',permissions:[]};
 await check('unmanaged roles still follow verified launch claims',async()=>{
  await db.query("INSERT INTO users(id,tenant_id,name,email,role,kleegr_user_id) VALUES('upstream','a','Upstream','upstream@example.test','salesperson','upstream')");
  const login=await upsertUserForClaims('a',{...claims,sp_user_id:'upstream',email:'upstream@example.test'} as any,'admin',db.query as any);
  assert.equal(login.role,'admin');
 });
 await check('saved app role survives a later SSO launch',async()=>{
  const login=await upsertUserForClaims('a',claims as any,'salesperson',db.query as any);
  assert.equal(login.role,'admin');assert.equal((await connected()).role,'admin');
 });
 await check('Make salesman enrolls exactly once and preserves admin role',async()=>{
  const user=await connected();const first=await tx(db=>enrollCompanyUser(db,admin,{userId:user.id}));
  const second=await tx(db=>enrollCompanyUser(db,admin,{userId:user.id}));
  assert.equal(first.salespersonId,second.salespersonId);assert.equal((await connected()).role,'admin');
 });
 await check('changing role revokes sessions and preserves the salesman identity',async()=>{
  const user=await connected();await db.query("INSERT INTO sessions(id,user_id,tenant_id,expires_at) VALUES('session',$1,'a',now()+interval '1 day')",[user.id]);
  await change(admin,user.id,'partner','admin');const updated=await connected();assert.equal(updated.salesperson_id,user.salesperson_id);
  assert.equal((await db.query('SELECT * FROM sessions WHERE user_id=$1',[user.id])).rows.length,0);
  assert.equal((await db.query('SELECT role FROM salespeople WHERE id=$1',[user.salesperson_id])).rows[0].role,'partner');
 });
 await check('removing access stays disabled across SSO and can be reactivated',async()=>{
  const user=await connected();await change(admin,user.id,'none','partner');
  const login=await upsertUserForClaims('a',claims as any,'admin',db.query as any);assert.equal(login.status,'inactive');assert.equal(login.role,'partner');
  await change(admin,user.id,'admin','partner','inactive');assert.equal((await connected()).status,'active');
 });
 await check('owner can appoint another owner and later change their role',async()=>{
  await change(owner,'rep','owner','salesperson');await change(owner,'rep','salesperson','owner');
  const rep=(await db.query("SELECT * FROM users WHERE id='rep'")).rows[0];assert.ok(rep.salesperson_id);
 });
 await check('a different verified identity cannot take over a locally managed email',async()=>{
  await assert.rejects(upsertUserForClaims('a',{...claims,sp_user_id:'impostor'} as any,'owner',db.query as any),/another verified user/);
 });
 await check('role changes are audited and the additive migration preserves them',async()=>{
  assert.ok((await db.query("SELECT * FROM audit_logs WHERE action='app_role_changed'")).rows.length>=5);
  await pg.exec(MIGRATIONS_SQL);assert.equal((await connected()).role_managed_locally,true);
 });
 console.log(`${checks} isolated user-management scenarios passed.`);
}finally{await pg.close();}
