import {publishPlan,assignPlan} from './tracker-people.js';
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
import publicProposal from '../proposal.js';
import {configuredItems,productQuote,valueEstimate} from '../../src/lib/proposal-suite.js';
import {proposalTotals} from '../../src/lib/proposal-pricing.js';
import {syncProposalHandover} from './proposal-suite.js';

process.env.NODE_ENV='test';
const pg=new PGlite();
const wrap=(p:any)=>({query:async(q:string,v:any[]=[])=>v.length?p.query(q,v):(await p.exec(q)).at(-1)||{rows:[]}});
const db:any={...wrap(pg),transaction:(f:any)=>pg.transaction(c=>f(wrap(c)))};
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
async function call(handler:any,body:any={},role='owner',method='POST'){
  let status=200,value:any;const response:any={setHeader(){},status(n:number){status=n;return this;},json(v:any){value=v;return this;}};
  await handler({method,headers:{host:'app.test',authorization:`Bearer ${role}-session`},query:method==='GET'?body:{},body:method==='POST'?body:{},url:'/api/proposal-workspace'},response);return {status,body:value};
}
const post=(body:any,role='owner')=>call(workspace,body,role);
const get=(body:any,role='owner')=>call(workspace,body,role,'GET');
const pub=(body:any,method='POST')=>call(publicProposal,body,'public',method);
let checks=0;async function check(name:string,run:()=>Promise<void>|void){await run();console.log(`✓ ${name}`);checks++;}
try{
  await pg.exec(SCHEMA_SQL);await pg.exec(MIGRATIONS_SQL);await pg.exec(TRACKER_SCHEMA_SQL);await pg.exec(OPERATIONS_SCHEMA_SQL);
  await pg.exec(`INSERT INTO tenants(id,name,slug) VALUES('a','Acme','a'),('b','Other','b');
  INSERT INTO salespeople(id,tenant_id,name,email,role,status,manager_user_id) VALUES('sp','a','Seller','s@example.test','salesperson','active','manager'),('other-sp','a','Other seller','o@example.test','salesperson','active',NULL);
  INSERT INTO users(id,tenant_id,name,email,role,salesperson_id) VALUES('owner','a','Owner','owner@example.test','owner',NULL),('reviewer','a','Reviewer','reviewer@example.test','admin',NULL),('rep','a','Seller','s@example.test','salesperson','sp'),('manager','a','Manager','manager@example.test','sales_manager',NULL),('other','b','Other owner','other@example.test','owner',NULL),('accountant','a','Accountant','acct@example.test','accountant',NULL);
  INSERT INTO tracker_workspaces(tenant_id,currency,timezone,payout_terms) VALUES('a','USD','UTC','{"minorDigits":2}');
  INSERT INTO business_profiles(tenant_id,business_name,profile) VALUES('a','Acme','{"paymentTerms":"Pay on approval"}');
  INSERT INTO products(tenant_id,id,name,price_minor,currency,billing_kind,recurring_interval,status,commission_type,commission_bps) VALUES('a','plan','Main plan',10000,'USD','recurring','month','active','percent',1000),('a','seat','Extra seat',2000,'USD','recurring','month','active','percent',1000);
  INSERT INTO product_assignments(tenant_id,product_id,salesperson_id) VALUES('a','plan','sp'),('a','seat','sp');`);
  for(const user of ['owner','reviewer','rep','manager','other','accountant'])await db.query('INSERT INTO sessions(id,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval \'1 hour\')',[sha(`${user}-session`),user,user==='other'?'b':'a']);
  process.env.NODE_ENV='test';installTestDatabase(db);
  const owner:any={id:'owner',tenantId:'a',name:'Owner',role:'owner'};
  const plan=await db.transaction((c:any)=>publishPlan(c,owner,{name:'Standard',config:{currency:'USD',minorDigits:2,rules:[{id:'rate',name:'Commission',event:'payment',kind:'percent',value:'1000',beneficiary:'referrer',base:'gross',chargeFrom:1,holdDays:0,group:'standard',stacking:'exclusive',priority:1}]},effectiveFrom:'2020-01-01'}));
  await db.transaction((c:any)=>assignPlan(c,owner,{salespersonId:'sp',versionId:plan.id,effectiveFrom:'2020-01-01'}));
  const rule={minQty:1,maxQty:20,requiresProductId:'plan',includedFromProductId:'plan',includedPerParent:1,tiers:[{from:5,unitPriceMinor:'1500'}],onboarding:['Set up the seats'],costMinor:'500'};
  await check('product policies are admin-only; dependencies and tenant boundaries are enforced',async()=>{
    assert.equal((await post({op:'product_policy',productId:'seat',policy:rule},'rep')).status,403);
    assert.equal((await post({op:'product_policy',productId:'seat',policy:rule})).status,200);
    assert.equal((await post({op:'product_policy',productId:'plan',policy:{costMinor:'2000',onboarding:['Book kickoff']}})).status,200);
    assert.equal((await get({op:'product_policy',productId:'seat'},'other')).status,404);
  });
  const lines=[{productId:'plan',name:'Main plan',qty:1,unitPriceMinor:'10000',billingKind:'recurring',recurringInterval:'month'},{productId:'seat',name:'Extra seat',qty:5,unitPriceMinor:'1500',billingKind:'recurring',recurringInterval:'month'}];
  await check('included units and volume pricing agree in the browser and server',async()=>{
    const product={id:'seat',name:'Seat',price_minor:'2000',proposal_policy:rule};
    assert.deepEqual(productQuote(product,5,lines),{floorMinor:'1500',includedQty:1,error:''});
    const configured=configuredItems(lines,[product]);assert.equal(configured[1].includedQty,1);assert.equal(proposalTotals(configured).firstPayment,16000n);
    assert.equal(valueEstimate({hoursPerMonth:10,hourlyValueMinor:'2500',adoptionPercent:80},'10000').monthlyBenefitMinor,'20000');
  });
  let docId='';
  await check('server rejects missing prerequisites and altered free quantities, then saves valid catalog snapshots',async()=>{
    const input={op:'create',kind:'proposal',title:'Suite test',prospect:{name:'Client Test',email:'client@example.test'},salespersonId:'sp',sections:[{id:'terms',type:'terms',title:'Terms',content:'Pay on approval'}]};
    assert.equal((await call(documents,{...input,lineItems:[lines[1]]},'rep')).body.error,'product_rule');
    assert.equal((await call(documents,{...input,lineItems:[lines[0],{...lines[1],qty:21}]},'rep')).status,400);
    const r=await call(documents,{...input,lineItems:lines.map(l=>({...l,includedQty:100}))},'rep');assert.equal(r.status,201,JSON.stringify(r.body));docId=r.body.id;
    const row=(await db.query('SELECT * FROM documents WHERE id=$1',[docId])).rows[0];assert.equal(row.line_items[1].includedQty,1);assert.equal(Number(row.amount),160);
  });
  await check('autosave resumes only the same user and rejects stale tab writes',async()=>{
    assert.equal((await post({op:'autosave',key:'new',version:0,payload:{title:'Resume me'}})).body.version,1);
    assert.equal((await get({op:'autosave',key:'new'})).body.payload.title,'Resume me');
    assert.equal((await get({op:'autosave',key:'new'},'rep')).body.payload,null);
    assert.equal((await post({op:'autosave',key:'new',version:0,payload:{title:'Overwrite'}})).status,409);
    assert.equal((await post({op:'autosave',key:'new',version:1,payload:{title:'Newer'}})).body.version,2);
    assert.equal((await post({op:'autosave',key:docId,payload:{}},'other')).status,404);
  });
  await check('private costs are absent from seller and manager workspace responses',async()=>{
    const rep=await get({id:docId},'rep');assert.equal(rep.status,200);assert.equal('costMinor' in rep.body.finance,false);assert.equal('marginMinor' in rep.body.finance,false);
    const manager=await get({id:docId},'manager');assert.equal(manager.status,200);assert.equal('costMinor' in manager.body.finance,false);
    const owner=await get({id:docId});assert.equal(owner.body.finance.costMinor,'4500');assert.equal(owner.body.finance.commissionEstimateMinor,'1600');assert.equal(owner.body.finance.marginMinor,'9900');
    assert.equal((await get({id:docId},'other')).status,404);assert.equal((await post({op:'revision',id:docId},'accountant')).status,401);
  });
  let opts:any;
  await check('package choices, dates and value assumptions persist with conflict checks',async()=>{
    const w=await get({id:docId});opts={...w.body.options,effectiveDate:'2026-10-01',deliveryDate:'2026-10-15',value:{hoursPerMonth:10,hourlyValueMinor:'2500',adoptionPercent:80},packages:[{id:'essential',name:'Essential',description:'Core plan',items:[lines[0]]},{id:'plus',name:'Plus',description:'Plan and seats',items:lines}]};
    assert.equal((await post({op:'options',id:docId,version:0,options:opts})).status,200);
    assert.equal((await post({op:'options',id:docId,version:0,options:opts})).status,409);
    opts=(await get({id:docId})).body.options;assert.equal(opts.packages[1].items[1].includedQty,1);
  });
  await check('approval policies block direct sharing; self approval and cross-tenant review fail',async()=>{
    await post({op:'policy',policy:{requireAll:true}});
    assert.equal((await call(documents,{op:'link',id:docId},'rep')).body.error,'approval_required');
    assert.equal((await post({op:'request_approval',id:docId},'rep')).status,200);
    assert.equal((await post({op:'review',id:docId,approved:true,note:'Approve'},'rep')).status,403);
    assert.equal((await post({op:'review',id:docId,approved:true,note:'Approve'},'other')).status,404);
    assert.equal((await post({op:'review',id:docId,approved:true,note:'Pricing and terms reviewed'},'reviewer')).status,200);
    await post({op:'options',id:docId,version:1,options:{...opts,deliveryDate:'2026-10-16'}},'rep');
    assert.equal((await call(documents,{op:'link',id:docId},'rep')).body.error,'approval_required');
    await post({op:'request_approval',id:docId},'owner');
    assert.equal((await post({op:'review',id:docId,approved:true,note:'My own'},'owner')).body.error,'separate_reviewer');
    await post({op:'review',id:docId,approved:true,note:'Reviewed updated delivery'},'reviewer');
  });
  let token='',second='';
  await check('new links preserve older links and freeze business branding',async()=>{
    const r=await call(documents,{op:'link',id:docId},'rep');assert.equal(r.status,200,JSON.stringify(r.body));token=r.body.link.split('/p/')[1];
    second=(await call(documents,{op:'link',id:docId},'rep')).body.link.split('/p/')[1];assert.notEqual(token,second);
    await db.query("UPDATE business_profiles SET business_name='Changed company' WHERE tenant_id='a'");
    assert.equal((await pub({token},'GET')).body.branding.businessName,'Acme');assert.equal((await pub({token:second},'GET')).status,200);
  });
  await check('client questions and replies stay on this proposal; unsafe attachments are rejected',async()=>{
    assert.equal((await pub({op:'message',token,name:'Client',message:'Please explain setup',requestChange:true,attachmentUrl:'javascript:alert(1)'})).status,400);
    assert.equal((await pub({op:'message',token,name:'Client',message:'Please explain setup',requestChange:true})).status,200);
    assert.equal((await post({op:'message',id:docId,message:'Setup is included.'},'rep')).status,200);
    const r=await pub({token},'GET');assert.equal(r.body.workspace.messages.length,2);assert.equal(r.body.workspace.messages[0].request_change,true);assert.equal(JSON.stringify(r.body).includes('costMinor'),false);
  });
  await check('package selection is required and exact approved items determine the payment',async()=>{
    const form={token,name:'Client Test',email:'client@example.test',signature:'Client Test',agree:true};
    assert.equal((await pub(form)).body.error,'package_required');assert.equal((await pub({...form,packageId:'fake'})).status,400);
    const accepted=await pub({...form,packageId:'essential'});assert.equal(accepted.status,200,JSON.stringify(accepted.body));
    const row=(await db.query('SELECT * FROM documents WHERE id=$1',[docId])).rows[0];assert.equal(row.line_items.length,1);assert.equal(Number(row.amount),100);
    assert.equal((await get({id:docId})).body.tasks.length,0,'approval alone creates no paid onboarding');
    assert.equal((await pub({...form,packageId:'plus'})).body.alreadyAccepted,true);assert.equal((await pub({token},'GET')).body.lineItems.length,1);
  });
  await check('verified payment creates onboarding exactly once from the shared product configuration',async()=>{
    await db.query("UPDATE payments SET receipt_status='confirmed' WHERE tenant_id='a' AND event_key=$1",[`proposal:${docId}`]);
    const row=(await db.query('SELECT * FROM documents WHERE id=$1',[docId])).rows[0];
    await db.query("UPDATE proposal_product_policies SET policy=policy||'{\"onboarding\":[\"Changed later\"]}'::jsonb WHERE product_id='plan'");
    await syncProposalHandover(db,row);await syncProposalHandover(db,row);
    const tasks=(await get({id:docId})).body.tasks;assert.equal(tasks.length,2);assert.ok(tasks.some((t:any)=>t.title.includes('Book kickoff')));
    assert.equal((await post({op:'task',id:docId,taskId:tasks[0].id,status:'done'},'rep')).status,200);
  });
  await check('renewals create a separate draft without changing approval or sending an invoice',async()=>{
    const r=await post({op:'revision',id:docId,kind:'renewal'},'rep');assert.equal(r.status,200,JSON.stringify(r.body));
    const row=(await db.query('SELECT * FROM documents WHERE id=$1',[r.body.id])).rows[0];assert.equal(row.status,'draft');assert.equal(row.ghl_invoice_id,null);assert.equal(row.public_token,null);
    assert.equal((await pub({token},'GET')).body.status,'signed');assert.equal((await get({id:r.body.id},'rep')).body.family.length,2);
  });
  await check('a zero-cost catalog offer never charges legacy client fees',async()=>{
    await post({op:'policy',policy:{requireAll:false}});
    const client=(await db.query('SELECT created_client_id FROM documents WHERE id=$1',[docId])).rows[0].created_client_id;
    await db.query('UPDATE clients SET setup_fee_amount=100,monthly_subscription_amount=50 WHERE id=$1',[client]);
    await db.query("INSERT INTO products(tenant_id,id,name,price_minor,currency,billing_kind,status) VALUES('a','free','Complimentary review',0,'USD','one_time','active')");
    const made=await call(documents,{op:'create',kind:'proposal',clientId:client,salespersonId:'sp',lineItems:[{productId:'free',qty:1,unitPriceMinor:'0'}]});
    const shared=await call(documents,{op:'link',id:made.body.id});const freeToken=shared.body.link.split('/p/')[1];
    const r=await pub({token:freeToken,name:'Client Test',email:'client@example.test',signature:'Client Test',agree:true});assert.equal(r.status,200);
    assert.equal((await db.query('SELECT receipt_event_key FROM documents WHERE id=$1',[made.body.id])).rows[0].receipt_event_key,null);
  });
  console.log(`${checks} proposal-suite integration checks passed.`);
}finally{await pg.close();}
