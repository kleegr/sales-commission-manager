// Isolated PGlite integration tests for the per-product affiliate program:
// product commission config, the (product,rep) tracking links minted by
// assignProducts, and the public click capture. Mirrors flow-catalog.test.ts:
// an embedded Postgres that cannot reach Neon or GHL. Not wired into
// package.json — run with: npx tsx api/_lib/flow-product-links.test.ts
import assert from 'node:assert/strict';
process.env.PUBLIC_BASE_URL='https://app.test';
import {SCHEMA_SQL} from './schema.js';
import {MIGRATIONS_SQL} from './migrations.js';
import {TRACKER_SCHEMA_SQL} from './tracker-schema.js';
import {saveProduct,assignProducts,listProducts} from './products.js';
import {listProductLinks,resolveProductLink,recordProductLinkClick} from './product-links.js';
import type {SessionUser} from './auth.js';

const moduleName=process.env.PGLITE_TEST_MODULE||'@electric-sql/pglite';
const {PGlite}=await import(moduleName);const pg=new PGlite();
const db={query:async(sql:string,params:any[]=[])=>pg.query(sql,params)};
const tx=(fn:(c:any)=>Promise<any>)=>pg.transaction((c:any)=>fn({query:(s:string,p:any[]=[])=>c.query(s,p)}));
const u:SessionUser={id:'owner',tenantId:'a',tenantSlug:'a',tenantName:'A',name:'Owner',email:'owner@example.test',role:'owner',salespersonId:null};
const bU:SessionUser={...u,tenantId:'b',tenantSlug:'b',tenantName:'B'};
const rep1:SessionUser={...u,id:'rep-user',role:'salesperson',salespersonId:'rep1'};
const linkFor=async(sp:string,prod:string)=>(await db.query('SELECT * FROM product_links WHERE tenant_id=$1 AND salesperson_id=$2 AND product_id=$3',['a',sp,prod])).rows[0];
let checks=0;async function check(name:string,fn:()=>any){await fn();checks++;console.log(`✓ ${name}`);}
try{
  await pg.exec(SCHEMA_SQL);await pg.exec(MIGRATIONS_SQL);
  await pg.exec("INSERT INTO tenants(id,name,slug) VALUES('a','A','a'),('b','B','b');INSERT INTO salespeople(id,tenant_id,name,role) VALUES('rep1','a','Rep One','salesperson'),('rep2','a','Rep Two','salesperson'),('repB','b','Rep B','salesperson');");
  await pg.exec(TRACKER_SCHEMA_SQL);
  await pg.exec("INSERT INTO tracker_workspaces(tenant_id,currency) VALUES('a','USD'),('b','USD')");

  let prodA='',prodB='';
  await check('saveProduct persists + reads back commission config',async()=>{
    const r=await tx(c=>saveProduct(c,u,{name:'Alpha',priceMinor:'10000',commissionType:'percent',commissionBps:2000,holdDays:14,destinationUrl:'https://buy.example.com/alpha?utm=x'}));
    prodA=r.id;assert.equal(r.commissionType,'percent');assert.equal(r.commissionBps,2000);assert.equal(r.holdDays,14);assert.equal(r.destinationUrl,'https://buy.example.com/alpha?utm=x');
    prodB=(await tx(c=>saveProduct(c,u,{name:'Beta',priceMinor:'5000',commissionType:'flat',commissionFlatMinor:'2500',destinationUrl:'https://buy.example.com/beta'}))).id;
    const a=(await listProducts(db,u,{q:'alph'})).rows[0];
    assert.equal(a.commission_type,'percent');assert.equal(a.commission_bps,2000);assert.equal(String(a.commission_flat_minor),'0');assert.equal(a.commission_hold_days,14);assert.equal(a.destination_url,'https://buy.example.com/alpha?utm=x');
    const b=(await listProducts(db,u,{q:'beta'})).rows[0];assert.equal(b.commission_type,'flat');assert.equal(String(b.commission_flat_minor),'2500');
  });
  await check('saveProduct defaults commission to none, empty destination',async()=>{
    const p=(await tx(c=>saveProduct(c,u,{name:'Plain',priceMinor:'1'})));assert.equal(p.commissionType,'none');assert.equal(p.commissionBps,0);assert.equal(p.destinationUrl,'');
  });
  await check('saveProduct rejects non-HTTPS destination + out-of-range commission',async()=>{
    await assert.rejects(tx(c=>saveProduct(c,u,{name:'Bad',priceMinor:'1',destinationUrl:'http://buy.example.com'})),{code:'invalid_destination'});
    await assert.rejects(tx(c=>saveProduct(c,u,{name:'Bad',priceMinor:'1',commissionBps:200000})),{code:'invalid_commission'});
    await assert.rejects(tx(c=>saveProduct(c,u,{name:'Bad',priceMinor:'1',holdDays:5000})),{code:'invalid_commission'});
  });

  let linkA='',linkB='';
  await check('assignProducts mints an active link per (product,rep)',async()=>{
    await tx(c=>assignProducts(c,u,{salespersonId:'rep1',productIds:[prodA,prodB]}));
    const la=await linkFor('rep1',prodA),lb=await linkFor('rep1',prodB);
    assert.ok(la&&lb);assert.equal(la.active,true);assert.equal(lb.active,true);
    assert.ok(/^[A-Za-z0-9_-]{16,64}$/.test(la.link_id));assert.notEqual(la.link_id,lb.link_id);
    linkA=la.link_id;linkB=lb.link_id;
  });
  await check('re-assign of the same set keeps link_id stable',async()=>{
    await tx(c=>assignProducts(c,u,{salespersonId:'rep1',productIds:[prodA,prodB]}));
    assert.equal((await linkFor('rep1',prodA)).link_id,linkA);assert.equal((await linkFor('rep1',prodB)).link_id,linkB);
  });
  await check('unassign deactivates (keeps link_id, active=false)',async()=>{
    await tx(c=>assignProducts(c,u,{salespersonId:'rep1',productIds:[prodA]}));
    const lb=await linkFor('rep1',prodB);assert.equal(lb.link_id,linkB);assert.equal(lb.active,false);
    assert.equal((await linkFor('rep1',prodA)).active,true);
  });
  await check('re-assign reactivates the SAME link_id',async()=>{
    await tx(c=>assignProducts(c,u,{salespersonId:'rep1',productIds:[prodA,prodB]}));
    const lb=await linkFor('rep1',prodB);assert.equal(lb.link_id,linkB);assert.equal(lb.active,true);
  });
  await check('listProductLinks by salesperson vs product, with public url',async()=>{
    await tx(c=>assignProducts(c,u,{salespersonId:'rep2',productIds:[prodA]}));
    const bySp=await listProductLinks(db,u,{salespersonId:'rep1'});assert.equal(bySp.total,2);
    const row=bySp.rows.find((r:any)=>r.product_id===prodA);
    assert.equal(row.product_name,'Alpha');assert.equal(row.salesperson_name,'Rep One');assert.equal(row.destination_url,'https://buy.example.com/alpha?utm=x');
    assert.equal(row.url,`https://app.test/pl/${row.link_id}`);
    const byProd=await listProductLinks(db,u,{productId:prodA});assert.equal(byProd.total,2); // rep1 + rep2
    assert.equal((await listProductLinks(db,u,{productId:prodB})).total,1); // rep1 only
  });
  await check('salesperson read scope sees only their own links',async()=>{
    // tracker-read applies the scope; here we assert the underlying filter behaves.
    const own=await listProductLinks(db,rep1,{salespersonId:rep1.salespersonId||'__none__'});
    assert.equal(own.total,2);assert.ok(own.rows.every((r:any)=>r.salesperson_id==='rep1'));
  });
  await check('recordProductLinkClick inserts a click resolving tenant/product/rep',async()=>{
    const before=Number((await db.query('SELECT count(*)::text AS n FROM product_link_clicks WHERE link_id=$1',[linkA])).rows[0].n);
    const r=await recordProductLinkClick(db,linkA,{ip:'203.0.113.7',ref:'https://ref.example.com',contactId:'contact-1'});
    assert.equal(r.ok,true);assert.equal(r.salespersonId,'rep1');assert.equal(r.productId,prodA);
    const click=(await db.query('SELECT * FROM product_link_clicks WHERE link_id=$1 ORDER BY created_at DESC LIMIT 1',[linkA])).rows[0];
    assert.equal(click.tenant_id,'a');assert.equal(click.salesperson_id,'rep1');assert.equal(click.ip,'203.0.113.7');assert.equal(click.contact_id,'contact-1');
    assert.equal(Number((await db.query('SELECT count(*)::text AS n FROM product_link_clicks WHERE link_id=$1',[linkA])).rows[0].n),before+1);
  });
  await check('recordProductLinkClick ignores unknown + inactive links',async()=>{
    assert.deepEqual(await recordProductLinkClick(db,'unknown-link-id-000000',{ip:'x'}),{ignored:true});
    await tx(c=>assignProducts(c,u,{salespersonId:'rep1',productIds:[prodA]})); // deactivates rep1/prodB link
    assert.equal((await linkFor('rep1',prodB)).active,false);
    assert.deepEqual(await recordProductLinkClick(db,linkB,{ip:'x'}),{ignored:true});
    assert.equal(Number((await db.query('SELECT count(*)::text AS n FROM product_link_clicks WHERE link_id=$1',[linkB])).rows[0].n),0);
  });
  await check('resolveProductLink returns row + destination, null for bad id',async()=>{
    const r=await resolveProductLink(db,linkA);assert.equal(r.salesperson_id,'rep1');assert.equal(r.destination_url,'https://buy.example.com/alpha?utm=x');assert.equal(r.active,true);
    assert.equal(await resolveProductLink(db,'!!bad!!'),null);
    assert.equal(await resolveProductLink(db,'missing-link-id-00000'),null);
  });
  await check('tenant isolation: links + clicks never cross tenants',async()=>{
    const prodBonly=(await tx(c=>saveProduct(c,bU,{name:'BOnly',priceMinor:'100',destinationUrl:'https://buy.example.com/b'}))).id;
    await tx(c=>assignProducts(c,bU,{salespersonId:'repB',productIds:[prodBonly]}));
    assert.equal((await listProductLinks(db,u,{})).rows.some((r:any)=>r.salesperson_id==='repB'),false);
    assert.equal((await listProductLinks(db,bU,{})).total,1);
    // tenant a cannot reactivate/see tenant b's link via reconcile
    const bLink=(await db.query("SELECT link_id FROM product_links WHERE tenant_id='b'")).rows[0].link_id;
    const res=await recordProductLinkClick(db,bLink,{ip:'x'});assert.equal(res.tenantId,'b');
  });
  console.log(`\n${checks} product-link + commission-config scenarios passed.`);
  await pg.close();
}catch(e){console.error(e);await pg.close();process.exit(1);}
