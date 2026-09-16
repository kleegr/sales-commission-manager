// GHL-native invoicing + automatic per-line-item commission — isolated integration test
// (embedded PGlite; NO network: the GHL invoice client is a fake). Covers:
//   - parseInvoicePaidEvent (pure) recognises the paid-invoice shapes
//   - approving a multi-line proposal on a GHL-connected tenant creates ONE invoice record
//   - a paid-invoice webhook posts ONE commission per line item using the product-specific
//     structure (assert per-product DIFFERENT rates), flows the campaign through, marks the
//     document paid, and cancels the pending fallback receipt
//   - redelivery is idempotent (no double commission)
//   - a document with no campaign/products still pays via the participant's ordinary assignment
//   - createInvoiceForDocument throws ghl_not_connected when the tenant isn't connected
//   - tenant isolation (an invoice id maps only to its own tenant's document)
//   - existing recordPayment behaviour is unchanged when no override is passed
// Run: `npx tsx api/_lib/flow-ghl-invoice.test.ts`.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SCHEMA_SQL} from './schema.js';
import {MIGRATIONS_SQL} from './migrations.js';
import {TRACKER_SCHEMA_SQL} from './tracker-schema.js';
import {OPERATIONS_SCHEMA_SQL} from './operations-schema.js';
import {installTestDatabase} from './db.js';
import {publishPlan,assignPlan} from './tracker-people.js';
import documentsHandler from '../documents.js';
import proposalHandler from '../proposal.js';
import {recordPayment} from './tracker-finance.js';
import {createInvoiceForDocument,applyInvoicePaidEvent,parseInvoicePaidEvent,setGhlInvoiceClient,type GhlInvoiceClient,type CreateInvoiceRequest} from './ghl-invoicing.js';
import type {ExactPlan} from '../../src/lib/exact-commission.js';
import type {SessionUser} from './auth.js';

const {PGlite}=await import(process.env.PGLITE_TEST_MODULE||'@electric-sql/pglite');const pg=new PGlite();
const wrap=(p:any)=>({query:async(q:string,v:any[]=[])=>{if(v.length)return p.query(q,v);const out=await p.exec(q);return out[out.length-1]||{rows:[]};}});
const db:any={...wrap(pg),transaction:(f:any)=>pg.transaction((c:any)=>f(wrap(c)))};const tx=(f:any)=>db.transaction(f);
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const owner:SessionUser={id:'owner',tenantId:'a',tenantSlug:'a',tenantName:'Acme',name:'Owner',email:'owner@example.test',role:'owner',salespersonId:null};
const sysB:SessionUser={id:'sysb',tenantId:'b',tenantSlug:'b',tenantName:'Beta',name:'Owner B',email:'ownerb@example.test',role:'owner',salespersonId:null};
const call=async(handler:any,req:any)=>{let status=200,body:any;const res:any={setHeader(){},status(n:number){status=n;return this;},json(b:any){body=b;return this;},send(b:any){body=b;return this;}};await handler({headers:{},query:{},url:'/api/x',...req},res);return{status,body};};
const asRep=(body:any)=>({method:'POST',url:'/api/documents',headers:{authorization:'Bearer rep-session',host:'app.test'},body});
const pub=(req:any)=>call(proposalHandler,{url:'/api/proposal',headers:{host:'app.test'},...req});
const count=async(sql:string,v:any[]=[])=>Number((await db.query(`SELECT count(*)::int AS n FROM ${sql}`,v)).rows[0].n);
let checks=0;const check=async(name:string,fn:()=>any)=>{await fn();checks++;console.log(`✓ ${name}`);};

// Fake GHL invoice client: records every call, returns a deterministic invoice id. No network.
const invoiceCalls:CreateInvoiceRequest[]=[];let invSeq=0;
const fakeClient:GhlInvoiceClient={async createAndSend(req){invSeq++;invoiceCalls.push(req);return{invoiceId:`ghl_inv_${invSeq}`,status:'sent',url:`https://pay.test/${invSeq}`,contactId:req.contact.id||`ghl_contact_${invSeq}`};}};

try{
  await pg.exec(SCHEMA_SQL);await pg.exec(MIGRATIONS_SQL);await pg.exec(MIGRATIONS_SQL);await pg.exec(TRACKER_SCHEMA_SQL);await pg.exec(OPERATIONS_SCHEMA_SQL);
  await pg.exec(`INSERT INTO tenants(id,name,slug) VALUES('a','Acme','a'),('b','Beta','b');
    UPDATE tenants SET ghl_location_id='loc_a',kleegr_connection_status='connected',status='active' WHERE id='a';
    INSERT INTO salespeople(id,tenant_id,name,email,role,status) VALUES('sp-alice','a','Alice Rep','alice@example.test','salesperson','active'),('sp-bob','b','Bob Rep','bob@example.test','salesperson','active');
    INSERT INTO users(id,tenant_id,name,email,role,salesperson_id) VALUES('rep','a','Alice Rep','alice@example.test','salesperson','sp-alice');
    INSERT INTO sessions(id,user_id,tenant_id,expires_at) VALUES('${sha('rep-session')}','rep','a',now()+interval '1 hour');
    INSERT INTO tracker_workspaces(tenant_id,currency,timezone,payout_terms) VALUES('a','USD','UTC','{"minorDigits":2,"separateApprover":true}'),('b','USD','UTC','{"minorDigits":2}');
    INSERT INTO business_profiles(tenant_id,business_name,contact_email) VALUES('a','Acme Studio','hello@acme.test');
    INSERT INTO products(tenant_id,id,name,currency,price_minor,status) VALUES('a','prodX','Product X','USD',0,'active'),('a','prodY','Product Y','USD',0,'active'),('b','prodZ','Product Z','USD',0,'active');
    INSERT INTO product_assignments(tenant_id,product_id,salesperson_id) VALUES('a','prodX','sp-alice'),('a','prodY','sp-alice');
    INSERT INTO campaigns(id,tenant_id,name,status) VALUES('camp1','a','Spring Push','active'),('campb','b','Beta Push','active');`);
  process.env.NODE_ENV='test';installTestDatabase(db);delete process.env.RESEND_API_KEY;
  setGhlInvoiceClient(fakeClient);

  // Plans: product X pays 20%, product Y pays 5% (DIFFERENT per-product rates); base plan 10%.
  const mk=(bps:string):ExactPlan=>({currency:'USD',minorDigits:2,rules:[{id:'r',name:'Rate',event:'payment',kind:'percent',value:bps,beneficiary:'referrer',base:'gross',chargeFrom:1,holdDays:0,group:'standard',stacking:'exclusive',priority:1}]});
  const vX=await tx((c:any)=>publishPlan(c,owner,{name:'Plan X',config:mk('2000'),effectiveFrom:'2020-01-01'}));
  const vY=await tx((c:any)=>publishPlan(c,owner,{name:'Plan Y',config:mk('500'),effectiveFrom:'2020-01-01'}));
  const vBase=await tx((c:any)=>publishPlan(c,owner,{name:'Base',config:mk('1000'),effectiveFrom:'2020-01-01'}));
  await tx((c:any)=>assignPlan(c,owner,{salespersonId:'sp-alice',versionId:vBase.id,effectiveFrom:'2020-01-01'}));
  await db.query('INSERT INTO campaign_product_structures(tenant_id,campaign_id,product_id,plan_version_id) VALUES($1,$2,$3,$4),($1,$2,$5,$6)',['a','camp1','prodX',vX.id,'prodY',vY.id]);
  // Tenant B plan + assignment for the isolation scenario.
  const vBaseB=await tx((c:any)=>publishPlan(c,sysB,{name:'Base B',config:mk('1000'),effectiveFrom:'2020-01-01'}));
  await tx((c:any)=>assignPlan(c,sysB,{salespersonId:'sp-bob',versionId:vBaseB.id,effectiveFrom:'2020-01-01'}));

  await check('parseInvoicePaidEvent recognises paid-invoice shapes and ignores the rest',()=>{
    assert.deepEqual(parseInvoicePaidEvent('InvoicePaid',{invoice:{_id:'i1',status:'paid'},locationId:'loc_a'}),{ghlInvoiceId:'i1',status:'paid',locationId:'loc_a'});
    assert.deepEqual(parseInvoicePaidEvent('invoice.paid',{data:{invoice:{id:'i2'},locationId:'loc_a'}}),{ghlInvoiceId:'i2',status:'paid',locationId:'loc_a'});
    assert.equal(parseInvoicePaidEvent('InvoiceUpdate',{invoice:{_id:'i3',status:'sent'}}),null,'unpaid invoice update is not a payment');
    assert.deepEqual(parseInvoicePaidEvent('InvoiceUpdate',{invoice:{_id:'i4',status:'paid'},altId:'loc_a'}),{ghlInvoiceId:'i4',status:'paid',locationId:'loc_a'});
    assert.equal(parseInvoicePaidEvent('ContactCreate',{id:'c1'}),null);assert.equal(parseInvoicePaidEvent('InvoicePaid',{status:'paid'}),null,'no invoice id → not actionable');
  });

  let docId='',invoiceId='';
  await check('approving a multi-line proposal on a connected tenant creates ONE invoice record + a pending fallback receipt',async()=>{
    const c=await call(documentsHandler,asRep({op:'create',kind:'proposal',prospect:{name:'Pat Prospect',email:'pat@example.test',company:'Prospect Co',setupFee:100},title:'Growth plan',campaignId:'camp1',lineItems:[{productId:'prodX',qty:1,unitPriceMinor:'10000'},{productId:'prodY',qty:2,unitPriceMinor:'5000'}]}));
    assert.equal(c.status,201,JSON.stringify(c.body));docId=c.body.id;
    const token=(await call(documentsHandler,asRep({op:'send',id:docId}))).body.link.split('/p/')[1];
    const before=invoiceCalls.length;
    const a=await pub({method:'POST',body:{token,name:'Pat Prospect',email:'pat@example.test',signature:'Pat Prospect',agree:true}});
    assert.equal(a.status,200,JSON.stringify(a.body));assert.ok(a.body.invoice,'invoice info returned to the public page');
    assert.equal(invoiceCalls.length,before+1,'exactly one GHL invoice created');
    const req=invoiceCalls[invoiceCalls.length-1];assert.equal(req.items.length,2);assert.deepEqual(req.items.map(i=>i.price),[100,50],'minor→major prices per line');
    const d=(await db.query('SELECT * FROM documents WHERE id=$1',[docId])).rows[0];invoiceId=d.ghl_invoice_id;
    assert.ok(invoiceId&&d.ghl_invoice_url&&d.ghl_invoice_status==='sent');assert.equal(a.body.invoice.id,invoiceId);
    const p=(await db.query('SELECT * FROM payments WHERE tenant_id=$1 AND event_key=$2',['a',`proposal:${docId}`])).rows;
    assert.equal(p.length,1);assert.equal(p[0].receipt_status,'pending','pending fallback receipt kept');
    assert.equal(await count('commission_ledger'),0,'no commission until the invoice is paid');
  });

  await check('a paid-invoice webhook posts ONE commission per line item at PRODUCT-SPECIFIC rates, flows the campaign, marks paid, cancels the fallback',async()=>{
    const r=await tx((c:any)=>applyInvoicePaidEvent(c,{ghlInvoiceId:invoiceId,status:'paid',locationId:'loc_a'}));
    assert.equal(r.applied,true);assert.equal(r.action,'invoice_paid');assert.equal(r.lineCount,2);assert.equal(r.earnings,2);
    const client=(await db.query('SELECT id FROM clients WHERE tenant_id=$1 AND email=$2',['a','pat@example.test'])).rows[0];
    const led=(await db.query('SELECT * FROM commission_ledger WHERE tenant_id=$1 AND client_id=$2 ORDER BY amount_minor DESC',['a',client.id])).rows;
    assert.equal(led.length,2,'one commission per line item');
    assert.equal(String(led[0].amount_minor),'2000','Product X: 20% of $100.00');
    assert.equal(String(led[1].amount_minor),'500','Product Y: 5% of $100.00 (2×$50)');
    assert.equal(led[0].plan_version_id,vX.id);assert.equal(led[1].plan_version_id,vY.id);
    assert.equal(led[0].campaign_id,'camp1');assert.equal(led[1].campaign_id,'camp1');assert.equal(led[0].salesperson_id,'sp-alice');
    const pays=(await db.query('SELECT event_key,receipt_status,campaign_id FROM payments WHERE tenant_id=$1 AND event_key LIKE $2 ORDER BY event_key',['a',`proposal:${docId}:%`])).rows;
    assert.deepEqual(pays.map((p:any)=>p.event_key),[`proposal:${docId}:0`,`proposal:${docId}:1`]);assert.ok(pays.every((p:any)=>p.receipt_status==='confirmed'&&p.campaign_id==='camp1'));
    assert.equal((await db.query('SELECT ghl_invoice_status FROM documents WHERE id=$1',[docId])).rows[0].ghl_invoice_status,'paid');
    assert.equal((await db.query('SELECT receipt_status FROM payments WHERE tenant_id=$1 AND event_key=$2',['a',`proposal:${docId}`])).rows[0].receipt_status,'cancelled','pending fallback superseded');
  });

  await check('webhook redelivery is idempotent — no duplicate commission or receipts',async()=>{
    const before=[await count('commission_ledger'),await count('payments')];
    const r=await tx((c:any)=>applyInvoicePaidEvent(c,{ghlInvoiceId:invoiceId,status:'paid',locationId:'loc_a'}));
    assert.equal(r.applied,true);assert.deepEqual([await count('commission_ledger'),await count('payments')],before);
  });

  await check('a document with NO campaign/products still pays via the participant’s ordinary assignment (fallback)',async()=>{
    const c=await call(documentsHandler,asRep({op:'create',kind:'proposal',prospect:{name:'Fern Fallback',email:'fern@example.test'},title:'Simple',lineItems:[{productId:'prodX',qty:1,unitPriceMinor:'10000'}]}));
    const docId2=c.body.id;const token=(await call(documentsHandler,asRep({op:'link',id:docId2}))).body.link.split('/p/')[1];
    await pub({method:'POST',body:{token,name:'Fern Fallback',email:'fern@example.test',signature:'Fern',agree:true}});
    const inv2=(await db.query('SELECT ghl_invoice_id FROM documents WHERE id=$1',[docId2])).rows[0].ghl_invoice_id;assert.ok(inv2);
    const r=await tx((c:any)=>applyInvoicePaidEvent(c,{ghlInvoiceId:inv2,status:'paid',locationId:'loc_a'}));assert.equal(r.earnings,1);
    const client=(await db.query('SELECT id FROM clients WHERE tenant_id=$1 AND email=$2',['a','fern@example.test'])).rows[0];
    const led=(await db.query('SELECT * FROM commission_ledger WHERE tenant_id=$1 AND client_id=$2',['a',client.id])).rows;
    assert.equal(led.length,1);assert.equal(String(led[0].amount_minor),'1000','base plan 10% of $100.00 (no product structure)');assert.equal(led[0].plan_version_id,vBase.id);
  });

  await check('createInvoiceForDocument throws ghl_not_connected when the tenant is not connected',async()=>{
    await db.query("INSERT INTO documents(id,tenant_id,kind,title,client_id,salesperson_id,amount,line_items) VALUES('doc-b','b','proposal','B doc',NULL,'sp-bob',10000,'[{\"productId\":\"prodZ\",\"name\":\"Z\",\"qty\":1,\"unitPriceMinor\":\"10000\",\"billingKind\":\"one_time\"}]')");
    await db.query("INSERT INTO clients(id,tenant_id,salesperson_id,company_name,contact_name,email,setup_fee_amount,monthly_subscription_amount,referrer_id,campaign_id) VALUES('cl-b','b','sp-bob','Beta Client','Bea','bea@example.test',0,0,'sp-bob','campb')");
    await db.query("UPDATE documents SET client_id='cl-b' WHERE id='doc-b'");
    await assert.rejects(tx((c:any)=>createInvoiceForDocument(c,sysB,'doc-b')),{code:'ghl_not_connected'});
  });

  await check('tenant isolation: a paid invoice maps ONLY to its own tenant’s document',async()=>{
    await db.query("UPDATE tenants SET ghl_location_id='loc_b',kleegr_connection_status='connected',status='active' WHERE id='b'");
    const inv=await tx((c:any)=>createInvoiceForDocument(c,sysB,'doc-b'));assert.ok(inv.invoiceId);
    const aLedgerBefore=await count("commission_ledger WHERE tenant_id='a'");
    const r=await tx((c:any)=>applyInvoicePaidEvent(c,{ghlInvoiceId:inv.invoiceId,status:'paid',locationId:'loc_b'}));
    assert.equal(r.tenantId,'b');assert.equal(r.earnings,1);
    assert.equal(await count("commission_ledger WHERE tenant_id='a'"),aLedgerBefore,'tenant A ledger untouched');
    assert.equal(await count("commission_ledger WHERE tenant_id='b'"),1);
    const miss=await tx((c:any)=>applyInvoicePaidEvent(c,{ghlInvoiceId:'ghl_inv_does_not_exist',status:'paid',locationId:'loc_a'}));
    assert.equal(miss.applied,false);assert.equal(miss.action,'no_document');
  });

  await check('existing recordPayment behaviour is UNCHANGED when no override/campaign is passed',async()=>{
    await db.query("INSERT INTO clients(id,tenant_id,salesperson_id,company_name,contact_name,email,referrer_id,attribution_status) VALUES('cl-plain','a','sp-alice','Plain LLC','Percy','percy@example.test','sp-alice','attributed')");
    const pay=await tx((c:any)=>recordPayment(c,owner,{eventKey:'plain-1',clientId:'cl-plain',date:'2026-02-02',amountMinor:'100000',currency:'USD',status:'confirmed'}));
    const led=(await db.query('SELECT * FROM commission_ledger WHERE payment_id=$1',[pay.id])).rows;
    assert.equal(led.length,1);assert.equal(String(led[0].amount_minor),'10000','base assignment 10% via the ordinary path');assert.equal(led[0].plan_version_id,vBase.id);
    assert.equal((await tx((c:any)=>recordPayment(c,owner,{eventKey:'plain-1',clientId:'cl-plain',date:'2026-02-02',amountMinor:'100000',currency:'USD',status:'confirmed'}))).duplicate,true);
  });

  console.log(`${checks} GHL invoice + auto-commission scenarios passed.`);
}finally{await pg.close();}
