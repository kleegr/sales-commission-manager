// Isolated PGlite integration tests for COMMISSION-ON-PURCHASE (the per-product
// affiliate program). Embedded Postgres, injected webhook payloads, NO network.
// Mirrors flow-product-links.test.ts / flow-ghl-invoice.test.ts. Covers:
//   - percent product: click via link -> paid-order "webhook" credits the rep the
//     right commission into the ledger, HELD per the product hold days
//   - flat product: credits the flat amount, payable immediately (hold 0)
//   - idempotent on webhook redelivery (event_key -> no double post)
//   - attribution by ref (the ?ref=<link_id>) AND by recent click+contact
//   - no attribution -> no post; unknown product -> no post; none-type -> no post
//   - admin manual creditProductSale works + is idempotent
//   - tenant isolation (an order credits only its own tenant; cross-tenant ref is ignored)
//   - existing recordPayment path unchanged; parseInvoicePaidEvent vs parseProductSaleEvent
//     do not cross-wire
// Not wired into package.json — run with: npx tsx api/_lib/flow-product-commission.test.ts
import assert from 'node:assert/strict';
process.env.PUBLIC_BASE_URL='https://app.test';
import {SCHEMA_SQL} from './schema.js';
import {MIGRATIONS_SQL} from './migrations.js';
import {TRACKER_SCHEMA_SQL} from './tracker-schema.js';
import {assignProducts} from './products.js';
import {recordProductLinkClick,attributeProductSale} from './product-links.js';
import {recordPayment,recordProductCommission} from './tracker-finance.js';
import {parseProductSaleEvent,applyProductSaleEvent,parseInvoicePaidEvent} from './ghl-invoicing.js';
import {publishPlan,assignPlan} from './tracker-people.js';
import {mutations} from '../tracker.js';
import type {ExactPlan} from '../../src/lib/exact-commission.js';
import type {SessionUser} from './auth.js';

const {PGlite}=await import(process.env.PGLITE_TEST_MODULE||'@electric-sql/pglite');const pg=new PGlite();
const wrap=(p:any)=>({query:async(q:string,v:any[]=[])=>{if(v.length)return p.query(q,v);const out=await p.exec(q);return out[out.length-1]||{rows:[]};}});
const db:any={...wrap(pg),transaction:(f:any)=>pg.transaction((c:any)=>f(wrap(c)))};const tx=(f:any)=>db.transaction(f);
const owner:SessionUser={id:'owner',tenantId:'a',tenantSlug:'a',tenantName:'Acme',name:'Owner',email:'owner@example.test',role:'owner',salespersonId:null};
const ownerB:SessionUser={...owner,id:'ownerb',tenantId:'b',tenantSlug:'b',tenantName:'Beta'};
const AT='2026-09-16';
const count=async(sql:string,v:any[]=[])=>Number((await db.query(`SELECT count(*)::int AS n FROM ${sql}`,v)).rows[0].n);
const ledgerFor=async(eventKey:string)=>(await db.query('SELECT * FROM commission_ledger WHERE event_key=$1',[eventKey])).rows[0];
const linkFor=async(sp:string,prod:string,tenant='a')=>(await db.query('SELECT link_id FROM product_links WHERE tenant_id=$1 AND salesperson_id=$2 AND product_id=$3',[tenant,sp,prod])).rows[0]?.link_id as string;
// A paid product-order webhook payload (GHL "OrderStatusUpdate"-ish shape).
const orderPayload=(o:{orderId:string;loc:string;ghlProductId:string;amount:string;contactId?:string|null;ref?:string|null;status?:string})=>
  ({type:'OrderStatusUpdate',locationId:o.loc,data:{order:{_id:o.orderId,altId:o.loc,status:o.status||'paid',currency:'USD',contactId:o.contactId??null,ref:o.ref??undefined,items:[{product:{_id:o.ghlProductId},qty:1,amount:o.amount}]}}});
const applyOrder=(p:any)=>tx((c:any)=>applyProductSaleEvent(c,parseProductSaleEvent(p.type,p),{at:AT}));
let checks=0;const check=async(name:string,fn:()=>any)=>{await fn();checks++;console.log(`✓ ${name}`);};

try{
  await pg.exec(SCHEMA_SQL);await pg.exec(MIGRATIONS_SQL);await pg.exec(TRACKER_SCHEMA_SQL);
  await pg.exec(`INSERT INTO tenants(id,name,slug,ghl_location_id,status) VALUES('a','Acme','a','loc_a','active'),('b','Beta','b','loc_b','active');
    INSERT INTO salespeople(id,tenant_id,name,email,role,status) VALUES
      ('rep1','a','Rep One','rep1@example.test','salesperson','active'),
      ('rep2','a','Rep Two','rep2@example.test','salesperson','active'),
      ('repB','b','Rep B','repb@example.test','salesperson','active');
    INSERT INTO tracker_workspaces(tenant_id,currency,timezone) VALUES('a','USD','UTC'),('b','USD','UTC');
    INSERT INTO products(tenant_id,id,name,currency,price_minor,status,ghl_product_id,commission_type,commission_bps,commission_flat_minor,commission_hold_days,destination_url) VALUES
      ('a','prodP','Percent Product','USD',10000,'active','ghlP','percent',2000,0,14,'https://buy.test/p'),
      ('a','prodF','Flat Product','USD',5000,'active','ghlF','flat',0,2500,0,'https://buy.test/f'),
      ('a','prodN','None Product','USD',5000,'active','ghlN','none',0,0,0,'https://buy.test/n'),
      ('b','prodBP','B Percent','USD',10000,'active','ghlBP','percent',1000,0,0,'https://buy.test/bp');
    INSERT INTO clients(id,tenant_id,salesperson_id,company_name,contact_name,email,ghl_contact_id,referrer_id,attribution_status) VALUES
      ('cl-buyer','a','rep1','Buyer LLC','Buy Er','buyer@example.test','contactC',NULL,'unattributed');`);
  // Mint tracking links via the real assignment path.
  await tx((c:any)=>assignProducts(c,owner,{salespersonId:'rep1',productIds:['prodP','prodF','prodN']}));
  await tx((c:any)=>assignProducts(c,owner,{salespersonId:'rep2',productIds:['prodP']}));
  await tx((c:any)=>assignProducts(c,ownerB,{salespersonId:'repB',productIds:['prodBP']}));
  const linkP1=await linkFor('rep1','prodP'),linkF1=await linkFor('rep1','prodF'),linkN1=await linkFor('rep1','prodN'),linkP2=await linkFor('rep2','prodP'),linkBP=await linkFor('repB','prodBP','b');

  await check('parseProductSaleEvent extracts per-product lines; ignores non-paid + invoice events',()=>{
    const lines=parseProductSaleEvent('OrderStatusUpdate',orderPayload({orderId:'o1',loc:'loc_a',ghlProductId:'ghlP',amount:'100.00',ref:linkP1}));
    assert.equal(lines.length,1);assert.equal(lines[0].productGhlId,'ghlP');assert.equal(lines[0].amountMinor,'10000');assert.equal(lines[0].orderId,'o1');assert.equal(lines[0].ref,linkP1);assert.equal(lines[0].locationId,'loc_a');
    assert.deepEqual(parseProductSaleEvent('OrderStatusUpdate',{data:{order:{_id:'o2',status:'pending',items:[{product:{_id:'ghlP'},amount:'10'}]}}}),[],'unpaid order is not actionable');
    assert.deepEqual(parseProductSaleEvent('InvoicePaid',{invoice:{_id:'i1',status:'paid'}}),[],'a paid invoice is NOT a product order');
    assert.deepEqual(parseProductSaleEvent('ContactCreate',{id:'c1'}),[],'non-order event ignored');
  });

  await check('percent product: paid order attributed by ref credits the rep, HELD per hold days',async()=>{
    const r=await applyOrder(orderPayload({orderId:'ordP',loc:'loc_a',ghlProductId:'ghlP',amount:'100.00',contactId:'contactC',ref:linkP1}));
    assert.equal(r.applied,true);assert.equal(r.tenantId,'a');assert.equal(r.credited,1);assert.equal(r.skipped,0);
    const e=await ledgerFor('productsale:ordP:ghlP');
    assert.ok(e,'ledger row posted');assert.equal(e.salesperson_id,'rep1');assert.equal(String(e.amount_minor),'2000','20% of $100.00');
    assert.equal(e.status,'pending');assert.equal(e.is_projection,false);assert.equal(e.currency,'USD');assert.equal(e.payment_type,'product_sale');
    assert.equal(e.due_date,'2026-09-30','sale date + 14 hold days');assert.ok(e.due_date>AT,'held: due date is in the future');
    assert.equal(e.client_id,'cl-buyer','mapped GHL contact -> our client');
  });

  await check('flat product: credits the flat amount, payable immediately (hold 0)',async()=>{
    const r=await applyOrder(orderPayload({orderId:'ordF',loc:'loc_a',ghlProductId:'ghlF',amount:'80.00',contactId:'contactC',ref:linkF1}));
    assert.equal(r.credited,1);
    const e=await ledgerFor('productsale:ordF:ghlF');
    assert.equal(e.salesperson_id,'rep1');assert.equal(String(e.amount_minor),'2500','flat amount, independent of order size');
    assert.equal(e.due_date,AT,'no hold -> due on the sale date (payable now)');assert.ok(e.due_date<=AT);
  });

  await check('webhook redelivery is idempotent — event_key blocks a double post',async()=>{
    const before=await count('commission_ledger');
    const r=await applyOrder(orderPayload({orderId:'ordP',loc:'loc_a',ghlProductId:'ghlP',amount:'100.00',contactId:'contactC',ref:linkP1}));
    assert.equal(r.applied,true);assert.equal(r.credited,0,'nothing newly credited');assert.equal(r.skipped,1);
    assert.equal(await count('commission_ledger'),before,'no duplicate ledger row');
  });

  await check('attribution by recent click + contact (no ref) credits the clicking rep',async()=>{
    await recordProductLinkClick(db,linkP2,{ip:'203.0.113.9',contactId:'contactClick'});
    const r=await applyOrder(orderPayload({orderId:'ordClick',loc:'loc_a',ghlProductId:'ghlP',amount:'50.00',contactId:'contactClick'}));
    assert.equal(r.credited,1);
    const e=await ledgerFor('productsale:ordClick:ghlP');
    assert.equal(e.salesperson_id,'rep2','credited to the rep whose link the contact clicked');assert.equal(String(e.amount_minor),'1000','20% of $50.00');
  });

  await check('attributeProductSale resolution order + window (unit)',async()=>{
    // ref wins over a click
    const byRef=await attributeProductSale(db,'a',{productGhlId:'ghlP',ref:linkP1,contactId:'contactClick'});
    assert.equal(byRef?.salespersonId,'rep1');assert.equal(byRef?.linkId,linkP1);
    // click fallback when no ref
    const byClick=await attributeProductSale(db,'a',{productGhlId:'ghlP',contactId:'contactClick'});
    assert.equal(byClick?.salespersonId,'rep2');
    // a click outside the window is not attributed
    await db.query("UPDATE product_link_clicks SET created_at=now()-interval '400 days' WHERE contact_id='contactClick'");
    assert.equal(await attributeProductSale(db,'a',{productGhlId:'ghlP',contactId:'contactClick',windowDays:30}),null,'stale click ignored');
    // unknown product -> null
    assert.equal(await attributeProductSale(db,'a',{productGhlId:'ghlNOPE',ref:linkP1}),null);
  });

  await check('no attribution -> no post; none-type product -> no post; unknown product -> no post',async()=>{
    const before=await count('commission_ledger');
    const noAttr=await applyOrder(orderPayload({orderId:'ordNo',loc:'loc_a',ghlProductId:'ghlP',amount:'100.00',contactId:'nobody'}));
    assert.equal(noAttr.credited,0);assert.equal(noAttr.skipped,1);
    const noneType=await applyOrder(orderPayload({orderId:'ordNone',loc:'loc_a',ghlProductId:'ghlN',amount:'100.00',contactId:'contactC',ref:linkN1}));
    assert.equal(noneType.credited,0,'none-type product pays nothing');assert.equal(await ledgerFor('productsale:ordNone:ghlN'),undefined);
    const unknown=await applyOrder(orderPayload({orderId:'ordUnk',loc:'loc_a',ghlProductId:'ghlNOTOURS',amount:'100.00',contactId:'contactC',ref:linkP1}));
    assert.equal(unknown.credited,0,'product not in our catalog -> skipped');
    assert.equal(await count('commission_ledger'),before,'nothing posted for any of the three');
  });

  await check('recordProductCommission is directly idempotent + skips none/zero',async()=>{
    const first=await tx((c:any)=>recordProductCommission(c,owner,{tenantId:'a',productId:'prodF',salespersonId:'rep1',orderAmountMinor:'9999',currency:'USD',eventKey:'direct:1',at:AT}));
    assert.equal((first as any).commissionMinor,'2500');
    const dup=await tx((c:any)=>recordProductCommission(c,owner,{tenantId:'a',productId:'prodF',salespersonId:'rep1',orderAmountMinor:'9999',currency:'USD',eventKey:'direct:1',at:AT}));
    assert.equal((dup as any).duplicate,true);
    const none=await tx((c:any)=>recordProductCommission(c,owner,{tenantId:'a',productId:'prodN',salespersonId:'rep1',orderAmountMinor:'9999',currency:'USD',eventKey:'direct:none',at:AT}));
    assert.equal((none as any).skipped,true);assert.equal(await ledgerFor('direct:none'),undefined);
  });

  await check('admin manual creditProductSale posts + is idempotent on the reference',async()=>{
    const r=await tx((c:any)=>mutations.creditProductSale(c,owner,{productId:'prodF',salespersonId:'rep2',amountMinor:'0',reference:'MANUAL-77'}));
    assert.ok((r as any).id);assert.equal((r as any).commissionMinor,'2500','flat product, manual credit');
    const e=await ledgerFor('manualproductsale:MANUAL-77');assert.equal(e.salesperson_id,'rep2');assert.equal(e.currency,'USD');
    const dup=await tx((c:any)=>mutations.creditProductSale(c,owner,{productId:'prodF',salespersonId:'rep2',amountMinor:'0',reference:'MANUAL-77'}));
    assert.equal((dup as any).duplicate,true);
    assert.equal(await count("commission_ledger WHERE event_key='manualproductsale:MANUAL-77'"),1);
    // non-admin is rejected
    await assert.rejects(tx((c:any)=>mutations.creditProductSale(c,{...owner,role:'salesperson',salespersonId:'rep1'},{productId:'prodF',salespersonId:'rep2',amountMinor:'0',reference:'X'})),{code:'forbidden'});
  });

  await check('tenant isolation: an order credits only its own tenant; cross-tenant ref is ignored',async()=>{
    const aBefore=await count("commission_ledger WHERE tenant_id='a'");
    const r=await applyOrder(orderPayload({orderId:'ordB',loc:'loc_b',ghlProductId:'ghlBP',amount:'100.00',contactId:'cB',ref:linkBP}));
    assert.equal(r.tenantId,'b');assert.equal(r.credited,1);
    const e=await ledgerFor('productsale:ordB:ghlBP');assert.equal(e.tenant_id,'b');assert.equal(e.salesperson_id,'repB');assert.equal(String(e.amount_minor),'1000');
    assert.equal(await count("commission_ledger WHERE tenant_id='a'"),aBefore,'tenant A ledger untouched');
    // an order into loc_a carrying tenant B's link_id must NOT attribute (link belongs to B)
    const cross=await applyOrder(orderPayload({orderId:'ordCross',loc:'loc_a',ghlProductId:'ghlP',amount:'100.00',contactId:'nobody',ref:linkBP}));
    assert.equal(cross.credited,0,'cross-tenant ref ignored');assert.equal(await ledgerFor('productsale:ordCross:ghlP'),undefined);
    // an unknown location -> no tenant
    const noTenant=await applyOrder(orderPayload({orderId:'ordX',loc:'loc_unknown',ghlProductId:'ghlP',amount:'100.00',ref:linkP1}));
    assert.equal(noTenant.applied,false);assert.equal(noTenant.action,'no_tenant');
  });

  await check('existing recordPayment path is UNCHANGED (base plan pays; idempotent)',async()=>{
    const mk=(bps:string):ExactPlan=>({currency:'USD',minorDigits:2,rules:[{id:'r',name:'Rate',event:'payment',kind:'percent',value:bps,beneficiary:'referrer',base:'gross',chargeFrom:1,holdDays:0,group:'standard',stacking:'exclusive',priority:1}]});
    const vBase=await tx((c:any)=>publishPlan(c,owner,{name:'Base',config:mk('1000'),effectiveFrom:'2020-01-01'}));
    await tx((c:any)=>assignPlan(c,owner,{salespersonId:'rep1',versionId:vBase.id,effectiveFrom:'2020-01-01'}));
    await db.query("UPDATE clients SET referrer_id='rep1',attribution_status='attributed' WHERE id='cl-buyer'");
    const pay=await tx((c:any)=>recordPayment(c,owner,{eventKey:'plain-1',clientId:'cl-buyer',date:'2026-02-02',amountMinor:'100000',currency:'USD',status:'confirmed'}));
    const led=(await db.query('SELECT * FROM commission_ledger WHERE payment_id=$1',[pay.id])).rows;
    assert.equal(led.length,1);assert.equal(String(led[0].amount_minor),'10000','base assignment 10% via the ordinary path');
    assert.equal((await tx((c:any)=>recordPayment(c,owner,{eventKey:'plain-1',clientId:'cl-buyer',date:'2026-02-02',amountMinor:'100000',currency:'USD',status:'confirmed'}))).duplicate,true);
    // parse guards: a paid invoice is recognised by the invoice parser, NOT the product parser
    assert.ok(parseInvoicePaidEvent('InvoicePaid',{invoice:{_id:'inv9',status:'paid'},altId:'loc_a'}));
    assert.deepEqual(parseProductSaleEvent('InvoicePaid',{invoice:{_id:'inv9',status:'paid'},altId:'loc_a'}),[]);
  });

  console.log(`\n${checks} commission-on-purchase scenarios passed.`);
  await pg.close();
}catch(e){console.error(e);await pg.close();process.exit(1);}
