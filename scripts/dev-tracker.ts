/** Isolated local browser verification. Does not read .env or contact Neon/GHL. */
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
if(process.env.VERCEL||['DATABASE_URL','POSTGRES_URL','DATABASE_URL_UNPOOLED','POSTGRES_PRISMA_URL','POSTGRES_URL_NON_POOLING','NEON_DATABASE_URL','KLEEGR_TOKEN_SERVICE_KEY'].some(k=>process.env[k]))throw new Error('Remove live credentials before starting the isolated harness.');
process.env.NODE_ENV='test';
const {PGlite}=await import(process.env.PGLITE_TEST_MODULE||'@electric-sql/pglite');const pg=new PGlite();
const wrap=(d:any)=>({query:async(s:string,p:any[]=[])=>{if(!p.length&&s.includes(';')){const results=await d.exec(s);const r=results[results.length-1];return{rows:r?.rows||[],rowCount:r?.affectedRows||0};}const r=await d.query(s,p);return{rows:r.rows,rowCount:r.affectedRows||r.rows.length};}});
const {installTestDatabase}=await import('../api/_lib/db.js');installTestDatabase({...wrap(pg),transaction:(fn:any)=>pg.transaction((c:any)=>fn(wrap(c)))});
const {ensureSchema}=await import('../api/_lib/repository.js');await ensureSchema();
const {TRACKER_SCHEMA_SQL}=await import('../api/_lib/tracker-schema.js');await pg.exec(TRACKER_SCHEMA_SQL);
const {EXPERIENCE_SCHEMA_SQL}=await import('../api/_lib/tracker-experience-schema.js');await pg.exec(EXPERIENCE_SCHEMA_SQL);
const {OPERATIONS_SCHEMA_SQL}=await import('../api/_lib/operations-schema.js');await pg.exec(OPERATIONS_SCHEMA_SQL);
const token='isolated-test-session';
await pg.exec(`INSERT INTO tenants(id,name,slug,ghl_location_id,kleegr_sub_account_id,kleegr_connection_status) VALUES('test','Isolated test workspace','isolated-test','fake-location','fake-subaccount','connected'); INSERT INTO users(id,tenant_id,name,email,role) VALUES('admin','test','Test administrator','admin@example.test','admin'),('approver','test','Separate approver','approver@example.test','admin'),('manager','test','Test manager','manager@example.test','sales_manager'); INSERT INTO external_users(tenant_id,external_id,name,email,provider_role) VALUES('test','alice','Alice Test','alice@example.test','admin'),('test','bob','Bob Test','bob@example.test','user');`);
await pg.query("INSERT INTO sessions(id,user_id,tenant_id,expires_at) VALUES($1,'admin','test',now()+interval '1 day')",[createHash('sha256').update(token).digest('hex')]);
// These fixtures exist only in this in-memory verification server.
const {mutations}=await import('../api/tracker.js');
const testUser={id:'admin',tenantId:'test',tenantSlug:'isolated-test',tenantName:'Isolated test workspace',name:'Test administrator',email:'admin@example.test',role:'admin',salespersonId:null};
const mutate=(action:string,b:any)=>pg.transaction((c:any)=>mutations[action](wrap(c),testUser,b));
await mutate('setup',{currency:'USD',minorDigits:2,timezone:'Asia/Karachi'});
await mutate('salesman',{firstName:'Jordan',lastName:'Test',email:'jordan@example.test'});
await mutate('lead',{name:'Contact Example',email:'contact@example.test',source:'isolated verification',date:'2026-09-09'});

// Fake catalog for testing the source wizard; it cannot reach a provider.
process.env.KLEEGR_READ_GATEWAY_ENABLED='1';process.env.KLEEGR_TOKEN_SERVICE_KEY='isolated-catalog-signing-key';
globalThis.fetch=async(input:any)=>{const url=new URL(String(input));if(url.pathname!=='/api/auth/ghl/read')throw new Error('External requests disabled in isolated harness');const resource=url.searchParams.get('resource');return Response.json({locationId:'fake-location',resource,payload:{funnels:[{_id:'test-funnel',name:'Checkout verification funnel',type:'funnel',locationId:'fake-location',url:'/offer',steps:[{id:'test-page',name:'Checkout',url:'/checkout'},{id:'thanks-page',name:'Thank you',url:'/thanks'}]},{_id:'test-site',name:'Verification website',type:'website',steps:[{id:'home',name:'Home',url:'/home'}]}]}});};

const {preview}=await import('vite');const {default:config}=await import('../vite.config.js');
const server=await preview({...config,configFile:false,preview:{host:'127.0.0.1',port:4184,strictPort:true},plugins:[...(config.plugins||[]),{name:'isolated-api',configurePreviewServer(vite:any){vite.middlewares.use(async(req:any,res:any,next:any)=>{
  const url=new URL(req.url,'http://127.0.0.1:4184');if(!url.pathname.startsWith('/api/'))return next();
  const relative=url.pathname.slice(1);if(!/^api\/[a-zA-Z0-9/_-]+$/.test(relative))return res.end('Not found');const file=resolve(`${relative}.ts`);if(!existsSync(file)){res.statusCode=404;return res.end(JSON.stringify({error:'not_found'}));}
  req.query=Object.fromEntries(url.searchParams);req.headers.authorization=`Bearer ${token}`;const parts:Buffer[]=[];for await(const part of req)parts.push(part);const raw=Buffer.concat(parts).toString();req.body=raw?JSON.parse(raw):{};
  res.status=(code:number)=>{res.statusCode=code;return res;};res.json=(value:any)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return res;};res.send=(value:any)=>{res.end(value);return res;};
  try{const handler=(await import(pathToFileURL(file).href)).default;await handler(req,res);}catch(e){console.error(e);if(!res.headersSent)res.status(500).json({error:'test_request_failed'});}
});}}]});console.log('Isolated browser test server: http://127.0.0.1:4184 — embedded Postgres, fake identities, no live credentials.');
