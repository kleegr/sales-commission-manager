import type {SessionUser} from './auth.js';
import {admin,audit,id,lock,participant,required,TrackerError,type SQL} from './tracker-common.js';
import {saveParticipant,assignPlan,publishPlan} from './tracker-people.js';
import {saveCampaign,safeDestination} from './tracker-attribution.js';
import {filteredQuery,listResource,report} from './tracker-read.js';

export async function experienceInstalled(db:SQL){return !!(await db.query("SELECT 1 FROM schema_migrations WHERE id='0013_tracker_experience'")).rows.length;}
async function ready(db:SQL){if(!await experienceInstalled(db))throw new TrackerError('experience_migration_required','The Sales Tracker interface update needs its database update before these new features can be saved.',503);}
function profile(b:any){
 const p:Record<string,string>={};
 for(const k of ['firstName','lastName','company','phone','companyPhone','vatId','country','address','website','avatar','facebook','x','youtube','instagram','linkedin']){
  if(b[k])p[k]=required(b[k],k, k==='address'?1000:500);
 }
 for(const k of ['website','avatar','facebook','x','youtube','instagram','linkedin'])if(p[k])p[k]=safeDestination(p[k]);
 return p;
}
function validEmail(value:any){const email=required(value,'Email',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new TrackerError('invalid_email','Enter a valid email address.');return email;}
export async function saveSalesman(db:SQL,u:SessionUser,b:any){
 admin(u);await ready(db);await lock(db,u.tenantId);
 const existing=b.id?await participant(db,u,b.id):null;
 const p=profile(b),name=existing?.ghl_user_id?existing.name:[required(b.firstName,'First name',100),required(b.lastName,'Last name',100)].join(' '),email=existing?.ghl_user_id?existing.email:validEmail(b.email);
 if(!b.id&&(await db.query('SELECT id FROM salespeople WHERE tenant_id=$1 AND lower(trim(email))=$2',[u.tenantId,email])).rows.length)throw new TrackerError('duplicate_email','A salesman with this email already exists. Open their profile instead.',409);
 const saved=await saveParticipant(db,u,{...b,name,email,role:b.role||'salesperson',status:b.status||'active'});
 await db.query('UPDATE salespeople SET tracker_profile=$3::jsonb,phone=CASE WHEN ghl_user_id IS NULL THEN $4 ELSE phone END WHERE tenant_id=$1 AND id=$2',[u.tenantId,saved.id,JSON.stringify(p),p.phone||'']);
 if(b.versionId)await assignPlan(db,u,{salespersonId:saved.id,versionId:b.versionId,effectiveFrom:b.effectiveFrom});
 return saved;
}
/** Preview and apply use identical validation. The surrounding transaction and tenant lock make imports atomic. */
export async function importSalesmen(db:SQL,u:SessionUser,b:any){
 admin(u);await ready(db);await lock(db,u.tenantId);
 let input:any[]=[];
 if(b.contactIds){
  if(!Array.isArray(b.contactIds)||!b.contactIds.length||b.contactIds.length>500)throw new TrackerError('invalid_selection','Select 1–500 contacts.');
  const unique=[...new Set(b.contactIds)];
  const contacts=(await db.query('SELECT id,contact_name,email,phone,company_name FROM clients WHERE tenant_id=$1 AND id=ANY($2::text[])',[u.tenantId,unique])).rows;
  if(contacts.length!==unique.length)throw new TrackerError('invalid_contact','A selected contact is unavailable in this workspace.',404);
  input=unique.map(key=>{const c=contacts.find(c=>c.id===key)!;const parts=c.contact_name.trim().split(/\s+/);return {contactId:c.id,firstName:parts.shift(),lastName:parts.join(' ')||'',email:c.email,phone:c.phone,company:c.company_name};});
 }else{
  if(!Array.isArray(b.rows)||!b.rows.length||b.rows.length>500)throw new TrackerError('invalid_rows','Upload 1–500 rows.');input=b.rows.map((r:any)=>({...r,contactId:undefined}));
 }
 const existing=(await db.query('SELECT lower(trim(email)) AS email,source_contact_id FROM salespeople WHERE tenant_id=$1',[u.tenantId])).rows;
 const seen=new Set(existing.map(r=>r.email)),contacts=new Set(existing.map(r=>r.source_contact_id).filter(Boolean));
 const review=input.map((row,index)=>{
  try{const email=validEmail(row.email),firstName=required(row.firstName,'First name',100);if(!b.contactIds)required(row.lastName,'Last name',100);profile(row);
   const duplicate=seen.has(email)||(row.contactId&&contacts.has(row.contactId));seen.add(email);if(row.contactId)contacts.add(row.contactId);
   return{row:index+1,name:[firstName,row.lastName].filter(Boolean).join(' '),email,status:duplicate?'skip':'ready',message:duplicate?'Already present; existing record will be kept.':'Ready to add',input:row};
  }catch(e){return{row:index+1,name:String(row.firstName||''),email:String(row.email||''),status:'error',message:e instanceof Error?e.message:'Invalid row',input:row};}
 });
 const result={rows:review.map(({input,...r})=>r),ready:review.filter(r=>r.status==='ready').length,skipped:review.filter(r=>r.status==='skip').length,errors:review.filter(r=>r.status==='error').length};
 if(b.preview)return result;
 if(result.errors)throw new TrackerError('invalid_import','Fix invalid rows before importing. Nothing has been added.');
 if(!['salesperson','affiliate','partner'].includes(b.role||'salesperson'))throw new TrackerError('invalid_role','Choose a valid commission role.');
 for(const row of review.filter(r=>r.status==='ready')){
  const saved=await saveParticipant(db,u,{name:row.name,email:row.email,role:b.role||'salesperson',status:'active'});
  await db.query('UPDATE salespeople SET phone=$3,tracker_profile=$4::jsonb,source_contact_id=$5 WHERE tenant_id=$1 AND id=$2',[u.tenantId,saved.id,row.input.phone||'',JSON.stringify(profile(row.input)),row.input.contactId||null]);
  if(b.versionId)await assignPlan(db,u,{salespersonId:saved.id,versionId:b.versionId,effectiveFrom:b.effectiveFrom});
 }
 await audit(db,u,'salespeople',u.tenantId,'bulk_imported',{added:result.ready,skipped:result.skipped,source:b.contactIds?'contacts':'csv'});
 return{...result,added:result.ready};
}
export async function createStructure(db:SQL,u:SessionUser,b:any){
 admin(u);await lock(db,u.tenantId);
 const version=await publishPlan(db,u,{name:b.name,description:b.description,effectiveFrom:b.effectiveFrom,config:b.config,preview:b.preview});
 if(b.preview)return version;
 const created=await saveCampaign(db,u,{...b,status:b.status||'draft',conversionMode:b.conversionMode||'native',windowDays:b.windowDays||30,versionId:version.id});
 for(const spId of new Set<string>(b.participantIds||[]))await assignPlan(db,u,{salespersonId:spId,versionId:version.id,effectiveFrom:b.effectiveFrom,campaignId:created.id});
 return{id:created.id,versionId:version.id};
}
export async function preferences(db:SQL,u:SessionUser,b:any){
 admin(u);await ready(db);await lock(db,u.tenantId);
 const allowed=['title','salesmanLabel','structureLabel','payoutLabel','mediaLabel','portalMessage','windowDays','touch','payoutTerms'];const data:Record<string,any>={};
 for(const k of allowed)if(b[k]!==undefined)data[k]=String(b[k]).trim().slice(0,k==='portalMessage'?1000:200);
 if(data.windowDays!==undefined&&(!/^\d+$/.test(data.windowDays)||+data.windowDays<1||+data.windowDays>365))throw new TrackerError('invalid_window','Cookie life must be 1–365 days.');
 if(data.touch&&!['first','last'].includes(data.touch))throw new TrackerError('invalid_touch','Choose first or last touch.');
 for(const k of ['title','salesmanLabel','structureLabel','payoutLabel','mediaLabel'])if(data[k]!==undefined&&!data[k])throw new TrackerError('invalid_label','Navigation names cannot be empty.');
 await db.query(`INSERT INTO tracker_preferences(tenant_id,preferences) VALUES($1,$2::jsonb) ON CONFLICT(tenant_id) DO UPDATE SET preferences=tracker_preferences.preferences||EXCLUDED.preferences,updated_at=now()`,[u.tenantId,JSON.stringify(data)]);
 await audit(db,u,'tracker_preferences',u.tenantId,'updated',data);return{ok:true};
}
export async function mediaFolder(db:SQL,u:SessionUser,b:any){admin(u);await ready(db);const key=id('folder');await db.query('INSERT INTO media_folders(id,tenant_id,name) VALUES($1,$2,$3)',[key,u.tenantId,required(b.name,'Folder name',100)]);await audit(db,u,'media_folder',key,'created',{});return{id:key};}
export async function saveMediaFile(db:SQL,u:SessionUser,b:any){
 admin(u);await ready(db);
 if(b.folderId&&!(await db.query('SELECT id FROM media_folders WHERE tenant_id=$1 AND id=$2',[u.tenantId,b.folderId])).rows.length)throw new TrackerError('invalid_folder','Folder not found.');
 if(b.campaignId&&!(await db.query('SELECT id FROM campaigns WHERE tenant_id=$1 AND id=$2',[u.tenantId,b.campaignId])).rows.length)throw new TrackerError('invalid_campaign','Structure not found.');
 const key=id('media'),fileId=id('file');let file:Buffer|undefined;
 if(b.base64){file=Buffer.from(required(b.base64,'File content',2800000),'base64');if(!file.length||file.length>2000000)throw new TrackerError('invalid_size','Files must be 2 MB or smaller.');
 const signatures:Record<string,boolean>={'application/pdf':file.subarray(0,5).toString()==='%PDF-','image/png':file.subarray(0,8).toString('hex')==='89504e470d0a1a0a','image/jpeg':file.subarray(0,3).toString('hex')==='ffd8ff','image/webp':file.subarray(0,4).toString()==='RIFF'&&file.subarray(8,12).toString()==='WEBP'};
 if(!signatures[b.mime])throw new TrackerError('invalid_file','Upload a valid PDF, PNG, JPG or WebP file.');
 }
 const url=file?`/api/tracker?resource=file&id=${fileId}`:safeDestination(b.url);
 await db.query('INSERT INTO media_resources(id,tenant_id,campaign_id,title,url,description,audience,created_by,folder_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[key,u.tenantId,b.campaignId||null,required(b.title,'File title'),url,String(b.description||'').slice(0,2000),b.audience==='admin'?'admin':'participants',u.id,b.folderId||null]);
 if(file)await db.query('INSERT INTO tracker_files(id,tenant_id,media_id,name,mime,content,size) VALUES($1,$2,$3,$4,$5,$6,$7)',[fileId,u.tenantId,key,required(b.fileName,'File name',200),b.mime,file,file.length]);
 await audit(db,u,'media',key,'created',{});return{id:key};
}
export async function readFile(db:SQL,u:SessionUser,key:string){
 await ready(db);const f=(await db.query('SELECT * FROM tracker_files WHERE tenant_id=$1 AND id=$2',[u.tenantId,key])).rows[0];
 if(!f||!(await listResource(db,u,'media',{id:f.media_id})).rows.length)throw new TrackerError('not_found','File not found.',404);return f;
}
export async function experienceRead(db:SQL,u:SessionUser,resource:string,f:any):Promise<any>{
 if(resource==='preferences'){return {preferences:await experienceInstalled(db)?(await db.query('SELECT preferences FROM tracker_preferences WHERE tenant_id=$1',[u.tenantId])).rows[0]?.preferences||{}:{},installed:await experienceInstalled(db)};}
 if(resource==='folders'){await ready(db);const scoped=await filteredQuery(db,u,'media',{});return{rows:(await db.query(`SELECT f.id,f.name FROM media_folders f WHERE f.tenant_id=$1 AND ($${scoped.values.length+1}::boolean OR f.id IN(SELECT r.folder_id ${scoped.base})) ORDER BY f.name`,[...scoped.values,['owner','admin'].includes(u.role)])).rows};}
 if(resource==='salesmen'){
  const page=await listResource(db,u,'people',f),ids=page.rows.map(r=>r.id);
  if(await experienceInstalled(db)&&ids.length){const profiles=(await db.query('SELECT id,phone,tracker_profile,source_contact_id FROM salespeople WHERE tenant_id=$1 AND id=ANY($2::text[])',[u.tenantId,ids])).rows;for(const row of page.rows)Object.assign(row,profiles.find(p=>p.id===row.id));}
  if(ids.length){
   const stats=(await db.query(`SELECT sp.id,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name)) FROM campaign_participants cp JOIN campaigns c ON c.id=cp.campaign_id AND c.tenant_id=cp.tenant_id WHERE cp.tenant_id=sp.tenant_id AND cp.salesperson_id=sp.id AND cp.active=true),'[]'::jsonb) AS structures,
    (SELECT jsonb_build_object('leads',count(*)::text,'customers',count(*) FILTER(WHERE customer_since IS NOT NULL)::text) FROM clients WHERE tenant_id=sp.tenant_id AND (referrer_id=sp.id OR salesperson_id=sp.id)) AS counts,
    (SELECT count(*)::text FROM referral_clicks WHERE tenant_id=sp.tenant_id AND salesperson_id=sp.id) AS clicks,
    (SELECT count(*)::text FROM salespeople child WHERE child.tenant_id=sp.tenant_id AND child.parent_salesperson_id=sp.id) AS sub_affiliates,
    COALESCE((SELECT jsonb_agg(x) FROM (SELECT currency,COALESCE(sum(amount_minor) FILTER(WHERE status='paid'),0)::text AS paid,COALESCE(sum(amount_minor) FILTER(WHERE status<>'paid'),0)::text AS owed FROM commission_ledger WHERE tenant_id=sp.tenant_id AND salesperson_id=sp.id AND amount_minor IS NOT NULL AND is_projection=false GROUP BY currency) x),'[]'::jsonb) AS money,
    COALESCE((SELECT jsonb_agg(x) FROM (SELECT currency,sum(amount_minor)::text AS amount FROM payments WHERE tenant_id=sp.tenant_id AND salesperson_id=sp.id AND amount_minor IS NOT NULL AND receipt_status='confirmed' GROUP BY currency) x),'[]'::jsonb) AS revenue
    FROM salespeople sp WHERE sp.tenant_id=$1 AND sp.id=ANY($2::text[])`,[u.tenantId,ids])).rows;
   const byId=new Map(stats.map(r=>[r.id,r]));for(const row of page.rows)Object.assign(row,byId.get(row.id));
  }return page;
 }
 if(resource==='overview'){
  const result=await report(db,u,f),p=await filteredQuery(db,u,'payments',f);
  const trend=(await db.query(`SELECT left(r.payment_date,7) AS month,r.currency,sum(r.amount_minor)::text AS amount_minor ${p.base} AND r.receipt_status='confirmed' AND r.amount_minor IS NOT NULL GROUP BY left(r.payment_date,7),r.currency ORDER BY month`,p.values)).rows;
  const people=await filteredQuery(db,u,'people',{});const count=(await db.query(`SELECT count(*)::text AS n ${people.base}`,people.values)).rows[0].n;
  return{...result,trend,salesmen:count};
 }
 throw new TrackerError('unknown_resource','Resource unavailable.');
}
