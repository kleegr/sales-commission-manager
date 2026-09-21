// Entirely isolated: embedded Postgres, fake invoices, fake AI, no outgoing requests.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {SCHEMA_SQL} from './schema.js';
import {MIGRATIONS_SQL} from './migrations.js';
import {TRACKER_SCHEMA_SQL} from './tracker-schema.js';
import {OPERATIONS_SCHEMA_SQL} from './operations-schema.js';
import {installTestDatabase} from './db.js';
import documents from '../documents.js';
import workspace from '../proposal-workspace.js';
import proposal from '../proposal.js';
import ai from '../ai.js';
import {mutations} from '../tracker.js';
import {recordPayment} from './tracker-finance.js';
import {publishPlan,assignPlan} from './tracker-people.js';
import {applyInvoicePaidEvent,createInvoiceForDocument,setGhlInvoiceClient} from './ghl-invoicing.js';
import {normalizeProductPolicy} from './proposal-suite.js';
import {configuredItems,productQuote,reviewProposal,valueEstimate} from '../../src/lib/proposal-suite.js';
import {proposalTotals} from '../../src/lib/proposal-pricing.js';

process.env.NODE_ENV='test';
delete process.env.RESEND_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_KEY;
const pg=new PGlite();
const wrap=(p:any)=>({query:async(q:string,v:any[]=[])=>v.length?p.query(q,v):(await p.exec(q)).at(-1)||{rows:[]}});
const db:any={...wrap(pg),transaction:(fn:any)=>pg.transaction(c=>fn(wrap(c)))};
const owner:any={id:'owner',tenantId:'a',name:'Owner',email:'owner@example.test',role:'owner'};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('Unexpected network call in proposal regression test');};
let invoiceCalls:any[]=[];
setGhlInvoiceClient({async createAndSend(req){invoiceCalls.push(req);return {invoiceId:`fake-invoice-${invoiceCalls.length}`,status:'sent',url:`https://pay.example.test/${invoiceCalls.length}`,contactId:'fake-contact'};}});
async function call(handler:any,body:any={},role='owner',method='POST'){
 let status=200,value:any;const res:any={setHeader(){},status(n:number){status=n;return this;},json(v:any){value=v;return this;}};
 await handler({method,headers:{host:'app.test',authorization:`Bearer ${role}-session`},query:method==='GET'?body:{},body:method==='POST'?body:{},url:'/api/test'},res);
 return {status,body:value};
}
const post=(body:any,role='owner')=>call(workspace,body,role);
const get=(body:any,role='owner')=>call(workspace,body,role,'GET');
const pub=(body:any,method='POST')=>call(proposal,body,'public',method);
const lines=[{productId:'setup',qty:1,unitPriceMinor:'10000'},{productId:'seat',qty:5,unitPriceMinor:'2000'}];
let seq=0;
async function make(items:any[]=lines){const r=await call(documents,{op:'create',kind:'proposal',title:`Verification ${++seq}`,prospect:{name:`Client ${seq}`,email:`client${seq}@example.test`},salespersonId:'sp',campaignId:'campaign',lineItems:items,sections:[{id:'terms',type:'terms',content:'Payment on approval'},{id:'scope',type:'scope',content:'Configure the workspace and provide the selected products.'}]});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.id;}
async function share(id:string){const r=await call(documents,{op:'link',id});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.link.split('/p/')[1];}
const sign=(token:string,extra:any={})=>pub({token,name:'Test Client',email:'test@example.test',signature:'Test Client',agree:true,...extra});
const row=async(id:string)=>(await db.query('SELECT * FROM documents WHERE id=$1',[id])).rows[0];
const ledger=async(id:string)=>(await db.query("SELECT COALESCE(sum(amount_minor),0)::text AS total,count(*)::int AS n FROM commission_ledger WHERE event_key LIKE $1",[`proposal:${id}:%`])).rows[0];
let passed=0;const failures:string[]=[];
async function check(name:string,fn:()=>any){try{await fn();passed++;console.log(`PASS ${name}`);}catch(e){failures.push(name);console.error(`FAIL ${name}:`,(e as Error).message);}}
try{
 await pg.exec(SCHEMA_SQL);await pg.exec(MIGRATIONS_SQL);await pg.exec(TRACKER_SCHEMA_SQL);await pg.exec(OPERATIONS_SCHEMA_SQL);installTestDatabase(db);
 await pg.exec(`INSERT INTO tenants(id,name,slug) VALUES('a','Acme','a'),('b','Other','b');
 INSERT INTO salespeople(id,tenant_id,name,email,role,status,manager_user_id) VALUES('sp','a','Alice','alice@example.test','salesperson','active','manager'),('outside','a','Bob','bob@example.test','salesperson','active',NULL);
 INSERT INTO users(id,tenant_id,name,email,role,salesperson_id) VALUES('owner','a','Owner','owner@example.test','owner',NULL),('reviewer','a','Reviewer','reviewer@example.test','admin',NULL),('rep','a','Alice','alice@example.test','salesperson','sp'),('unlinked','a','Unlinked','u@example.test','salesperson',NULL),('manager','a','Manager','m@example.test','sales_manager',NULL);
 INSERT INTO tracker_workspaces(tenant_id,currency,timezone,payout_terms) VALUES('a','USD','UTC','{"minorDigits":2}');
 INSERT INTO business_profiles(tenant_id,business_name,profile) VALUES('a','Acme','{"paymentTerms":"Payment on approval"}');
 INSERT INTO products(tenant_id,id,name,price_minor,currency,billing_kind,recurring_interval,status) VALUES('a','setup','Setup',10000,'USD','setup','month','active'),('a','seat','Seat',2000,'USD','recurring','month','active');
 INSERT INTO product_assignments(tenant_id,product_id,salesperson_id) VALUES('a','setup','sp'),('a','seat','sp');
 INSERT INTO campaigns(id,tenant_id,name,status) VALUES('campaign','a','Sales','active');`);
 for(const role of ['owner','reviewer','rep','unlinked','manager'])await db.query("INSERT INTO sessions(id,user_id,tenant_id,expires_at) VALUES($1,$2,'a',now()+interval '1 hour')",[hash(`${role}-session`),role]);
 const config=(bps:string)=>({currency:'USD',minorDigits:2,rules:[{id:'rate',name:'Rate',event:'payment',kind:'percent',value:bps,beneficiary:'referrer',base:'gross',chargeFrom:1,holdDays:0,group:'main',stacking:'exclusive',priority:1}]});
 const base=await db.transaction((c:any)=>publishPlan(c,owner,{name:'Default',config:config('1000'),effectiveFrom:'2020-01-01'}));
 const setup=await db.transaction((c:any)=>publishPlan(c,owner,{name:'Setup',config:config('2000'),effectiveFrom:'2020-01-01'}));
 const seat=await db.transaction((c:any)=>publishPlan(c,owner,{name:'Seats',config:config('500'),effectiveFrom:'2020-01-01'}));
 await db.transaction((c:any)=>assignPlan(c,owner,{salespersonId:'sp',versionId:base.id,effectiveFrom:'2020-01-01'}));
 await db.query("INSERT INTO campaign_product_structures(tenant_id,campaign_id,product_id,plan_version_id) VALUES('a','campaign','setup',$1),('a','campaign','seat',$2)",[setup.id,seat.id]);

 await check('quantity changes recalculate volume prices, inclusions and exact totals',()=>{
  const policy=normalizeProductPolicy({maxQty:10,includedFromProductId:'setup',includedPerParent:2,tiers:[{from:5,unitPriceMinor:'1500'}]});
  const p={id:'seat',name:'Seat',price_minor:'2000',proposal_policy:policy};
  const old:any=[lines[0],{...lines[1],qty:1,unitPriceMinor:'2000'}];
  const many=configuredItems([old[0],{...old[1],qty:5}],[p],old);assert.equal(many[1].unitPriceMinor,'1500');assert.equal(many[1].includedQty,2);assert.equal(proposalTotals(many).firstPayment,14500n);
  const few=configuredItems([many[0],{...many[1],qty:3}],[p],many);assert.equal(few[1].unitPriceMinor,'2000');assert.equal(proposalTotals(few).firstPayment,12000n);
  assert.ok(productQuote(p,11,many).error);assert.throws(()=>normalizeProductPolicy({minQty:5,maxQty:2}));assert.throws(()=>normalizeProductPolicy({tiers:[{from:2,unitPriceMinor:'1'},{from:2,unitPriceMinor:'2'}]}));
 });
 await check('value estimates and quality checks flag dates, placeholders and unbounded promises',()=>{
  assert.equal(valueEstimate({hoursPerMonth:10,hourlyValueMinor:'2599',adoptionPercent:80},'10000').monthlyBenefitMinor,'20792');
  const found=reviewProposal({title:'Review',items:[],sections:[{id:'s',type:'scope',title:'Scope',content:'[Business name] guarantees unlimited results.'}],options:{effectiveDate:'2026-10-20',deliveryDate:'2026-10-01',renewalDate:'',followUpDate:'',handoverNotes:'',approvalNote:'',packages:[],value:null}});
  for(const title of ['No products','Unfilled placeholders','Check strong promises','Delivery date conflict'])assert.ok(found.some(f=>f.title===title));
 });
 await check('sharing revalidates package prices after catalog changes',async()=>{
  const id=await make([lines[0]]);await post({op:'options',id,version:0,options:{packages:[{id:'choice',name:'Seats',items:[lines[1]]}]}});
  await db.query("UPDATE products SET price_minor=2500 WHERE tenant_id='a' AND id='seat'");
  try{assert.equal((await call(documents,{op:'link',id})).body.error,'price_below_floor');}finally{await db.query("UPDATE products SET price_minor=2000 WHERE tenant_id='a' AND id='seat'");}
 });
 await check('sharing revalidates package inclusions after rules change',async()=>{
  await post({op:'product_policy',productId:'seat',policy:{includedFromProductId:'setup',includedPerParent:1}});
  const id=await make([lines[0]]);await post({op:'options',id,version:0,options:{packages:[{id:'choice',name:'Bundle',items:lines}]}});
  await post({op:'product_policy',productId:'seat',policy:{includedFromProductId:'setup',includedPerParent:2}});
  try{assert.equal((await call(documents,{op:'link',id})).body.error,'pricing_changed');}finally{await post({op:'product_policy',productId:'seat',policy:{}});}
 });
 await check('unlinked salespeople cannot read unassigned proposals',async()=>{
  const id=await make();await db.query('UPDATE documents SET salesperson_id=NULL WHERE id=$1',[id]);assert.equal((await get({id},'unlinked')).status,404);
 });
 await check('stale autosave clear reports a conflict and preserves the newer draft',async()=>{
  await post({op:'autosave',key:'new',version:0,payload:{title:'One'}});await post({op:'autosave',key:'new',version:1,payload:{title:'Two'}});
  assert.equal((await post({op:'autosave',key:'new',version:1,clear:true})).status,409);assert.equal((await get({op:'autosave',key:'new'})).body.payload.title,'Two');
 });
 await check('valid internal approval remains visible after a client chooses an approved package',async()=>{
  const id=await make();await post({op:'options',id,version:0,options:{approvalNote:'Approve alternate packages',packages:[{id:'small',name:'Setup only',items:[lines[0]]}]}});
  await post({op:'request_approval',id});await post({op:'review',id,approved:true,note:'Reviewed'},'reviewer');
  const token=await share(id);assert.equal((await sign(token,{packageId:'small'})).status,200);assert.equal((await get({id})).body.approval.status,'approved');
 });
 await check('draft updates reject a stale version instead of overwriting saved work',async()=>{
  const id=await make();const old=new Date((await row(id)).updated_at).toISOString();
  assert.equal((await call(documents,{op:'update_document',id,expectedUpdatedAt:old,title:'Newer title'})).status,200);
  assert.equal((await call(documents,{op:'update_document',id,expectedUpdatedAt:old,title:'Stale title'})).status,409);assert.equal((await row(id)).title,'Newer title');
 });
 await check('draft editing accepts database timestamps with microsecond precision',async()=>{
  const id=await make();await db.query("UPDATE documents SET updated_at='2026-09-22T01:01:01.123456Z' WHERE id=$1",[id]);
  const version=new Date((await row(id)).updated_at).toISOString();
  assert.equal((await call(documents,{op:'update_document',id,expectedUpdatedAt:version,title:'Precision-safe edit'})).status,200);
  assert.equal((await call(documents,{op:'update_document',id,expectedUpdatedAt:version,title:'Stale retry'})).status,409);
 });
 await check('canceling and reopening revokes every old link',async()=>{
  const id=await make(),one=await share(id),two=await share(id);
  assert.equal((await call(documents,{op:'set_status',id,status:'canceled'})).status,200);assert.equal((await pub({token:one},'GET')).status,404);assert.equal((await pub({token:two},'GET')).status,404);
  await call(documents,{op:'set_status',id,status:'draft'});const three=await share(id);assert.equal((await pub({token:three},'GET')).status,200);assert.equal((await pub({token:one},'GET')).status,404);
 });
 await db.query("UPDATE tenants SET ghl_location_id='location-a',kleegr_connection_status='connected' WHERE id='a'");
 await check('repeated invoice requests reuse the same invoice',async()=>{
  const id=await make(),token=await share(id);await sign(token);const before=invoiceCalls.length,first=(await row(id)).ghl_invoice_id;
  const again=await db.transaction((c:any)=>createInvoiceForDocument(c,owner,id));assert.equal(again.invoiceId,first);assert.equal(invoiceCalls.length,before);
 });
 await check('wrong-location paid events cannot mutate a proposal',async()=>{
  const id=await make(),token=await share(id);await sign(token);const inv=(await row(id)).ghl_invoice_id;
  const r=await db.transaction((c:any)=>applyInvoicePaidEvent(c,{ghlInvoiceId:inv,status:'paid',locationId:'other-location'}));assert.equal(r.applied,false);assert.equal((await row(id)).ghl_invoice_status,'sent');assert.equal((await ledger(id)).n,0);
 });
 await check('manual confirmation respects product rates and subsequent invoice events cannot double-credit',async()=>{
  const id=await make(),token=await share(id);await sign(token);const d=await row(id);const pay=(await db.query('SELECT id FROM payments WHERE event_key=$1',[`proposal:${id}`])).rows[0];
  assert.equal((await call(documents,{},'owner','GET')).body.documents.find((v:any)=>v.id===id).paymentConfirmed,false);
  const preview=await db.transaction((c:any)=>mutations.confirmReceipt(c,owner,{id:pay.id,reason:'Test bank evidence',preview:true}));assert.equal(preview.totalCommissionMinor,'2500');assert.equal((await ledger(id)).n,0);
  await db.transaction((c:any)=>mutations.confirmReceipt(c,owner,{id:pay.id,reason:'Test bank evidence'}));assert.equal((await ledger(id)).total,'2500');
  const listed=(await call(documents,{},'owner','GET')).body.documents.find((v:any)=>v.id===id);assert.equal(listed.paymentConfirmed,true);assert.equal(listed.ghlInvoiceStatus,'sent');
  await db.transaction((c:any)=>applyInvoicePaidEvent(c,{ghlInvoiceId:d.ghl_invoice_id,status:'paid',locationId:'location-a'}));assert.equal((await ledger(id)).total,'2500');
  assert.equal((await db.query("SELECT sum(amount_minor)::text total FROM payments WHERE client_id=$1 AND receipt_status='confirmed'",[d.created_client_id])).rows[0].total,'20000');
  assert.equal((await db.transaction((c:any)=>mutations.confirmReceipt(c,owner,{id:pay.id,reason:'Retry'}))).duplicate,true);
 });
 await check('one proposal collection counts as one charge across all product lines',async()=>{
  const firstConfig=config('500');Object.assign(firstConfig.rules[0],{chargeTo:1});
  const firstOnly=await db.transaction((c:any)=>publishPlan(c,owner,{name:'First charge only',config:firstConfig,effectiveFrom:'2020-01-01'}));
  await db.query("UPDATE campaign_product_structures SET plan_version_id=$1 WHERE tenant_id='a' AND campaign_id='campaign' AND product_id='seat'",[firstOnly.id]);
  try{const id=await make(),token=await share(id);await sign(token);const d=await row(id),pay=(await db.query('SELECT id FROM payments WHERE event_key=$1',[`proposal:${id}`])).rows[0];
   assert.equal((await get({id})).body.finance.commissionEstimateMinor,'2500');
   await db.transaction((c:any)=>mutations.confirmReceipt(c,owner,{id:pay.id,reason:'One checkout, two products'}));assert.equal((await ledger(id)).total,'2500');
   assert.deepEqual((await db.query('SELECT payment_number FROM payments WHERE event_key LIKE $1 ORDER BY event_key',[`proposal:${id}:%`])).rows.map((v:any)=>v.payment_number),[1,1]);
   const next=await db.transaction((c:any)=>recordPayment(c,owner,{eventKey:`next:${id}`,clientId:d.created_client_id,date:'2026-09-22',amountMinor:'1000',currency:'USD',status:'confirmed',preview:true}));assert.equal(next.chargeNumber,2);
  }finally{await db.query("UPDATE campaign_product_structures SET plan_version_id=$1 WHERE tenant_id='a' AND campaign_id='campaign' AND product_id='seat'",[seat.id]);}
 });
 await check('invoice payment followed by manual retry or later-day webhook never double-counts',async()=>{
  const id=await make(),token=await share(id);await sign(token);const d=await row(id),pay=(await db.query('SELECT id FROM payments WHERE event_key=$1',[`proposal:${id}`])).rows[0];
  const event={ghlInvoiceId:d.ghl_invoice_id,status:'paid',locationId:'location-a'};
  await db.transaction((c:any)=>applyInvoicePaidEvent(c,event));assert.equal((await ledger(id)).total,'2500');
  assert.equal((await db.transaction((c:any)=>mutations.confirmReceipt(c,owner,{id:pay.id,reason:'Duplicate check'}))).duplicate,true);
  await db.query("UPDATE payments SET payment_date='2026-01-01' WHERE event_key LIKE $1",[`proposal:${id}:%`]);
  await db.transaction((c:any)=>applyInvoicePaidEvent(c,event));assert.equal((await ledger(id)).total,'2500');
 });
 await check('historical confirmed aggregate payments are preserved when an invoice callback arrives',async()=>{
  const id=await make(),token=await share(id);await sign(token);const d=await row(id),pay=(await db.query('SELECT * FROM payments WHERE event_key=$1',[`proposal:${id}`])).rows[0];
  await db.transaction((c:any)=>recordPayment(c,owner,{...JSON.parse(pay.financial_inputs.requestFingerprint),status:'confirmed',confirmExisting:true}));
  const before=await ledger(id);await db.transaction((c:any)=>applyInvoicePaidEvent(c,{ghlInvoiceId:d.ghl_invoice_id,status:'paid',locationId:'location-a'}));assert.deepEqual(await ledger(id),before);
  assert.equal((await db.query("SELECT sum(amount_minor)::text total FROM payments WHERE client_id=$1 AND receipt_status='confirmed'",[d.created_client_id])).rows[0].total,'20000');
 });
 await check('a cancelled unpaid receipt cannot be revived by confirmation',async()=>{
  const id=await make(),token=await share(id);await sign(token);const pay=(await db.query('SELECT id FROM payments WHERE event_key=$1',[`proposal:${id}`])).rows[0];
  await db.query("UPDATE payments SET receipt_status='cancelled' WHERE id=$1",[pay.id]);await assert.rejects(db.transaction((c:any)=>mutations.confirmReceipt(c,owner,{id:pay.id,reason:'Not collected'})),{code:'invalid_status'});assert.equal((await ledger(id)).n,0);
 });
 await check('free catalog proposals cannot create zero-value invoices',async()=>{
  await db.query("INSERT INTO products(tenant_id,id,name,price_minor,currency,status) VALUES('a','free','Free review',0,'USD','active')");
  const id=await make([{productId:'free',qty:1,unitPriceMinor:'0'}]),token=await share(id),before=invoiceCalls.length;await sign(token);
  await assert.rejects(db.transaction((c:any)=>createInvoiceForDocument(c,owner,id)),{code:'no_invoiceable_amount'});assert.equal(invoiceCalls.length,before);
 });
 await check('onboarding tasks progress, revisions preserve signatures, and expansions keep independent totals',async()=>{
  const id=await make(),token=await share(id);await sign(token);const d=await row(id);await db.transaction((c:any)=>applyInvoicePaidEvent(c,{ghlInvoiceId:d.ghl_invoice_id,status:'paid',locationId:'location-a'}));
  const tasks=(await get({id})).body.tasks;assert.ok(tasks.length);assert.equal((await post({op:'task',id,taskId:tasks[0].id,status:'doing'})).status,200);await post({op:'task',id,taskId:tasks[0].id,status:'done'});assert.equal((await get({id})).body.tasks[0].status,'done');
  for(const kind of ['revision','renewal','expansion']){const r=await post({op:'revision',id,kind});assert.equal(r.status,200);assert.equal((await row(r.body.id)).status,'draft');assert.equal((await row(r.body.id)).ghl_invoice_id,null);assert.equal((await get({id:r.body.id})).body.comparison.beforeMinor,'20000');}
  assert.equal((await row(id)).status,'signed');assert.equal((await pub({token},'GET')).body.accepted.name,'Test Client');
 });
 await check('included units agree across proposal, GHL invoice, commission and onboarding',async()=>{
  await post({op:'product_policy',productId:'seat',policy:{includedFromProductId:'setup',includedPerParent:2,onboarding:['Create accounts']}});
  try{const id=await make(),token=await share(id);await sign(token);const d=await row(id);assert.equal(invoiceCalls.at(-1).items.find((i:any)=>i.name==='Seat').quantity,3);
   await db.transaction((c:any)=>applyInvoicePaidEvent(c,{ghlInvoiceId:d.ghl_invoice_id,status:'paid',locationId:'location-a'}));assert.equal((await ledger(id)).total,'2300');assert.equal((await get({id})).body.tasks.length,2);
  }finally{await post({op:'product_policy',productId:'seat',policy:{}});}
 });
 await check('AI drafting and review return useful output and keep role-scoped history',async()=>{
  process.env.OPENAI_API_KEY='isolated-fake-key';
  globalThis.fetch=async(input:any,init:any)=>{assert.equal(String(input),'https://api.openai.com/v1/chat/completions');const b=JSON.parse(init.body);assert.ok(b.messages[1].content.includes('Acme'));return Response.json({choices:[{message:{content:JSON.stringify({title:'Review',sections:[{type:'custom',title:'Review',content:'At [Business name], confirm the delivery date before sharing.'}]})}}]});};
  const r=await call(ai,{op:'generate',kind:'proposal',target:'section',sectionType:'custom',instructions:'Review the proposal; do not change prices.'},'rep');assert.equal(r.status,200);assert.ok(r.body.sections[0].content.includes('Acme'));
  assert.equal((await call(ai,{resource:'history'},'rep','GET')).body.history.length,1);assert.equal((await call(ai,{resource:'history'},'unlinked','GET')).body.history.length,0);
  globalThis.fetch=async()=>Response.json({choices:[{message:{content:''}}]});assert.equal((await call(ai,{op:'generate'},'rep')).body.error,'ai_empty_response');
  globalThis.fetch=async()=>Response.json({error:{message:'Simulated unavailable provider'}},{status:503});assert.equal((await call(ai,{op:'generate'},'rep')).status,502);
  delete process.env.OPENAI_API_KEY;assert.equal((await call(ai,{op:'generate'},'rep')).status,409);
 });
 await check('AI cannot use a client outside the manager team',async()=>{
  process.env.OPENAI_API_KEY='isolated-fake-key';await db.query("INSERT INTO clients(id,tenant_id,salesperson_id,company_name,contact_name,email) VALUES('outside-client','a','outside','Private','Outside Client','outside@example.test')");
  globalThis.fetch=async()=>Response.json({choices:[{message:{content:'{"sections":[]}'}}]});assert.equal((await call(ai,{op:'generate',clientId:'outside-client'},'manager')).status,403);
 });
 console.log(`${passed} passed, ${failures.length} failed. ${failures.join('; ')}`);if(failures.length)process.exitCode=1;
}finally{globalThis.fetch=originalFetch;delete process.env.OPENAI_API_KEY;setGhlInvoiceClient(null);await pg.close();}
