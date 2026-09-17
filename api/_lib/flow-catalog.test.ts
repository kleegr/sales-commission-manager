// Isolated PGlite integration tests for the WAVE 1 product catalog + document
// line items. Mirrors the harness in tracker.integration.test.ts: an embedded
// Postgres that cannot reach Neon or GHL. Not wired into package.json (a later
// wave/coordinator does that) — run with: npx tsx api/_lib/flow-catalog.test.ts
import assert from 'node:assert/strict';
import {SCHEMA_SQL} from './schema.js';
import {MIGRATIONS_SQL} from './migrations.js';
import {TRACKER_SCHEMA_SQL} from './tracker-schema.js';
import {listProducts,listAssignments,campaignStructures,saveProduct,deleteProduct,assignProducts,setCampaignStructures,resolveProductStructure,validateDocumentLineItems,syncGhlProducts,readGhlProducts} from './products.js';
import {lineItemsAmountMinor,normalizeLineItems} from './documents-core.js';
import type {SessionUser} from './auth.js';

const moduleName=process.env.PGLITE_TEST_MODULE||'@electric-sql/pglite';
const {PGlite}=await import(moduleName);const pg=new PGlite();
const db={query:async(sql:string,params:any[]=[])=>pg.query(sql,params)};
const tx=(fn:(c:any)=>Promise<any>)=>pg.transaction((c:any)=>fn({query:(s:string,p:any[]=[])=>c.query(s,p)}));
const u:SessionUser={id:'owner',tenantId:'a',tenantSlug:'a',tenantName:'A',name:'Owner',email:'owner@example.test',role:'owner',salespersonId:null};
const bU:SessionUser={...u,tenantId:'b',tenantSlug:'b',tenantName:'B'};
const rep:SessionUser={...u,id:'rep-user',role:'salesperson',salespersonId:'rep1'};
let checks=0;async function check(name:string,fn:()=>any){await fn();checks++;console.log(`✓ ${name}`);}
try{
  await pg.exec(SCHEMA_SQL);await pg.exec(MIGRATIONS_SQL);
  await pg.exec("INSERT INTO tenants(id,name,slug) VALUES('a','A','a'),('b','B','b');INSERT INTO users(id,tenant_id,name,email,role) VALUES('owner','a','Owner','owner@example.test','owner');INSERT INTO salespeople(id,tenant_id,name,role) VALUES('rep1','a','Rep One','salesperson'),('rep2','a','Rep Two','salesperson'),('repB','b','Rep B','salesperson');");
  await pg.exec(TRACKER_SCHEMA_SQL);
  await pg.exec("INSERT INTO tracker_workspaces(tenant_id,currency) VALUES('a','USD'),('b','USD')");
  // Commission plan + two versions, and a campaign whose default is v1.
  await pg.exec("INSERT INTO commission_plans(id,tenant_id,name) VALUES('plan1','a','Plan One');INSERT INTO plan_versions(id,tenant_id,plan_id,version,effective_from,config,created_by) VALUES('v1','a','plan1',1,'2026-01-01','{}','owner'),('v2','a','plan1',2,'2026-02-01','{}','owner');INSERT INTO campaigns(id,tenant_id,name,plan_version_id) VALUES('camp1','a','Campaign One','v1');");

  let prodA='',prodB='';
  await check('product create + list',async()=>{
    prodA=(await tx(c=>saveProduct(c,u,{name:'Alpha',category:'core',priceMinor:'10000',billingKind:'one_time'}))).id;
    prodB=(await tx(c=>saveProduct(c,u,{name:'Beta',category:'addon',priceMinor:'5000',billingKind:'recurring',recurringInterval:'month'}))).id;
    const list=await listProducts(db,u,{});assert.equal(list.total,2);
    assert.equal((await listProducts(db,u,{q:'alph'})).total,1);
    assert.equal((await listProducts(db,u,{category:'addon'})).total,1);
    const a=(await listProducts(db,u,{q:'alph'})).rows[0];assert.equal(String(a.price_minor),'10000');assert.equal(a.currency,'USD');assert.equal(a.billing_kind,'one_time');
  });
  await check('product update mutates fields in place',async()=>{
    await tx(c=>saveProduct(c,u,{id:prodA,name:'Alpha Plus',category:'core',priceMinor:'12000',billingKind:'one_time'}));
    const a=(await db.query('SELECT * FROM products WHERE tenant_id=$1 AND id=$2',['a',prodA])).rows[0];
    assert.equal(a.name,'Alpha Plus');assert.equal(String(a.price_minor),'12000');
  });
  await check('non-admin cannot write catalog',async()=>{await assert.rejects(tx(c=>saveProduct(c,rep,{name:'Nope',priceMinor:'1'})),{code:'forbidden'});});
  await check('product archive hides from default list, retains under archived filter',async()=>{
    const tmp=(await tx(c=>saveProduct(c,u,{name:'Gamma',priceMinor:'1'}))).id;
    await tx(c=>deleteProduct(c,u,{id:tmp}));
    assert.equal((await listProducts(db,u,{})).rows.some((r:any)=>r.id===tmp),false);
    const archived=await listProducts(db,u,{status:'archived'});assert.equal(archived.rows.some((r:any)=>r.id===tmp),true);
    assert.equal((await tx(c=>deleteProduct(c,u,{id:tmp}))).duplicate,true);
  });
  await check('assignProducts is a replace-set for the rep',async()=>{
    await tx(c=>assignProducts(c,u,{salespersonId:'rep1',productIds:[prodA,prodB]}));
    assert.equal((await listAssignments(db,u,{salespersonId:'rep1'})).total,2);
    await tx(c=>assignProducts(c,u,{salespersonId:'rep1',productIds:[prodA]}));
    const only=await listAssignments(db,u,{salespersonId:'rep1'});assert.equal(only.total,1);assert.equal(only.rows[0].product_id,prodA);
    assert.equal((await listAssignments(db,u,{productId:prodA})).total,1);
    await assert.rejects(tx(c=>assignProducts(c,u,{salespersonId:'rep1',productIds:['ghost']})),{code:'unknown_product'});
  });
  await check('salesperson document with an assigned product validates + computes amount',async()=>{
    const r=await validateDocumentLineItems(db,'a',{salespersonId:'rep1',enforceAssignment:true},[{productId:prodA,qty:2,unitPriceMinor:'12000'}]);
    assert.equal(r.items.length,1);assert.equal(r.items[0].billingKind,'one_time');assert.equal(r.amountMinor,'24000');
    assert.equal(lineItemsAmountMinor(r.items),'24000');
  });
  await check('unassigned product for a salesperson fails product_not_assigned',async()=>{
    await assert.rejects(validateDocumentLineItems(db,'a',{salespersonId:'rep1',enforceAssignment:true},[{productId:prodB,qty:1,unitPriceMinor:'5000'}]),{code:'product_not_assigned'});
  });
  await check('admin (no assignment enforcement) may use any product',async()=>{
    const r=await validateDocumentLineItems(db,'a',{salespersonId:null,enforceAssignment:false},[{productId:prodB,qty:1,unitPriceMinor:'5000'}]);
    assert.equal(r.amountMinor,'5000');
  });
  await check('price below the admin floor fails price_below_floor',async()=>{
    await assert.rejects(validateDocumentLineItems(db,'a',{salespersonId:'rep1',enforceAssignment:true},[{productId:prodA,qty:1,unitPriceMinor:'11999'}]),{code:'price_below_floor'});
    // At or above the floor passes.
    const ok=await validateDocumentLineItems(db,'a',{salespersonId:'rep1',enforceAssignment:true},[{productId:prodA,qty:1,unitPriceMinor:'12000'}]);
    assert.equal(ok.amountMinor,'12000');
  });
  await check('unknown product id fails unknown_product',async()=>{
    await assert.rejects(validateDocumentLineItems(db,'a',{salespersonId:null,enforceAssignment:false},[{productId:'nope',qty:1,unitPriceMinor:'1'}]),{code:'unknown_product'});
  });
  await check('multi-line amount sums qty*unitPriceMinor',async()=>{
    const items=normalizeLineItems([{productId:prodA,qty:3,unitPriceMinor:'12000'},{productId:prodB,qty:2,unitPriceMinor:'5000'}]);
    assert.equal(lineItemsAmountMinor(items),'46000');
  });
  await check('proposal snapshots use catalog facts and reject inactive, cross-currency or malformed rows',async()=>{
    await db.query("UPDATE products SET description='Managed WhatsApp accounts',category='Messaging',recurring_interval='year' WHERE id=$1",[prodB]);
    const r=await validateDocumentLineItems(db,'a',{salespersonId:null,enforceAssignment:false},[{productId:prodB,qty:3,unitPriceMinor:'5000',name:'Tampered',billingKind:'one_time',description:'Invented'}]);
    assert.equal(r.items[0].name,'Beta');assert.equal(r.items[0].description,'Managed WhatsApp accounts');assert.equal(r.items[0].billingKind,'recurring');assert.equal(r.items[0].recurringInterval,'year');
    const stored=normalizeLineItems(JSON.parse(JSON.stringify(r.items)));assert.equal(stored[0].description,r.items[0].description);
    await db.query("UPDATE products SET status='inactive' WHERE id=$1",[prodB]);
    await assert.rejects(validateDocumentLineItems(db,'a',{salespersonId:null,enforceAssignment:false},[{productId:prodB,qty:1,unitPriceMinor:'5000'}]),{code:'inactive_product'});
    await db.query("UPDATE products SET status='active',currency='EUR' WHERE id=$1",[prodB]);
    await assert.rejects(validateDocumentLineItems(db,'a',{salespersonId:null,enforceAssignment:false},[{productId:prodB,qty:1,unitPriceMinor:'5000'}]),{code:'currency_mismatch'});
    await db.query("UPDATE products SET currency='USD' WHERE id=$1",[prodB]);
    await assert.rejects(validateDocumentLineItems(db,'a',{salespersonId:null,enforceAssignment:false},[{productId:prodB,qty:1.5,unitPriceMinor:'5000'}]),{code:'invalid_quantity'});
  });
  await check('campaign_product_structures set + resolver: product-specific vs campaign-default',async()=>{
    assert.equal(await resolveProductStructure(db,'a','camp1',prodA),'v1'); // no structure yet → campaign default
    await tx(c=>setCampaignStructures(c,u,{campaignId:'camp1',map:[{productId:prodA,planVersionId:'v2'}]}));
    assert.equal(await resolveProductStructure(db,'a','camp1',prodA),'v2'); // product-specific wins
    assert.equal(await resolveProductStructure(db,'a','camp1',prodB),'v1'); // falls back to campaign default
    const cs=await campaignStructures(db,u,{campaignId:'camp1'});assert.equal(cs.total,1);assert.equal(cs.map[0].planVersionId,'v2');
    // replace-set: empty map clears
    await tx(c=>setCampaignStructures(c,u,{campaignId:'camp1',map:[]}));
    assert.equal((await campaignStructures(db,u,{campaignId:'camp1'})).total,0);
    assert.equal(await resolveProductStructure(db,'a','camp1',prodA),'v1');
  });
  await check('setCampaignStructures rejects unknown product/version and duplicates',async()=>{
    await assert.rejects(tx(c=>setCampaignStructures(c,u,{campaignId:'camp1',map:[{productId:'ghost',planVersionId:'v1'}]})),{code:'unknown_product'});
    await assert.rejects(tx(c=>setCampaignStructures(c,u,{campaignId:'camp1',map:[{productId:prodA,planVersionId:'vX'}]})),{code:'unknown_plan_version'});
    await assert.rejects(tx(c=>setCampaignStructures(c,u,{campaignId:'camp1',map:[{productId:prodA,planVersionId:'v1'},{productId:prodA,planVersionId:'v2'}]})),{code:'duplicate_product'});
  });
  await check('tenant isolation: catalog, assignments and validation never cross tenants',async()=>{
    assert.equal((await listProducts(db,bU,{})).total,0);
    const prodBonly=(await tx(c=>saveProduct(c,bU,{name:'BOnly',priceMinor:'100'}))).id;
    assert.equal((await listProducts(db,u,{})).rows.some((r:any)=>r.id===prodBonly),false);
    // tenant b cannot validate against tenant a's product
    await assert.rejects(validateDocumentLineItems(db,'b',{salespersonId:null,enforceAssignment:false},[{productId:prodA,qty:1,unitPriceMinor:'12000'}]),{code:'unknown_product'});
    // resolver is tenant-scoped: tenant b has no camp1
    assert.equal(await resolveProductStructure(db,'b','camp1',prodA),null);
  });
  await check('syncGhlProducts throws ghl_not_connected when no location is linked',async()=>{
    await assert.rejects(tx(c=>syncGhlProducts(c,u,{})),{code:'ghl_not_connected'});
  });
  await check('syncGhlProducts upserts by ghl_product_id via the injected reader',async()=>{
    await db.query("UPDATE tenants SET ghl_location_id='loc-a',kleegr_connection_status='connected' WHERE id='a'");
    const reader:any=async()=>[{ghlProductId:'ghl-1',name:'Synced One',description:'d',priceMinor:'2500',currency:'USD',ghlPriceId:'price-1',billingKind:'recurring',recurringInterval:'month'}];
    const first=await tx(c=>syncGhlProducts(c,u,{},reader));assert.equal(first.created,1);assert.equal(first.updated,0);
    const row=(await db.query("SELECT * FROM products WHERE tenant_id='a' AND ghl_product_id='ghl-1'")).rows[0];assert.equal(row.name,'Synced One');assert.equal(String(row.price_minor),'2500');assert.equal(row.billing_kind,'recurring');
    const reader2:any=async()=>[{ghlProductId:'ghl-1',name:'Synced One v2',description:'d',priceMinor:'2600',currency:'USD',ghlPriceId:'price-1',billingKind:'recurring',recurringInterval:'month'}];
    const second=await tx(c=>syncGhlProducts(c,u,{},reader2));assert.equal(second.created,0);assert.equal(second.updated,1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM products WHERE tenant_id='a' AND ghl_product_id='ghl-1'")).rows[0].n,1);
  });
  console.log(`\n${checks} product-catalog + document line-item scenarios passed.`);
  await pg.close();
}catch(e){console.error(e);await pg.close();process.exit(1);}
