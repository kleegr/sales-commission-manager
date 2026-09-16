// ============================================================================
// PRODUCT CATALOG  —  tenant-scoped product data logic (Sales Commission Manager)
//
// WAVE 1 backend. Owns the products catalog, per-rep product assignments, the
// campaign→product→plan-version structure map, GHL product sync, the campaign
// structure resolver, and the document line-item validator. All reads/writes are
// tenant-scoped; every mutation is admin-gated (admin() from tracker-common).
//
// GHL sync reuses the SAME auth path as the rest of the tracker: it resolves the
// connected location from the tenant row and calls the GHL Products API either
// through the Kleegr read gateway (gatewayPage) or directly with the location
// token from resolveDirectoryTokens() — exactly like readProviderPage does. No
// new auth is invented, and no external Stripe is used (GHL-native pricing).
// ============================================================================
import type {SessionUser} from './auth.js';
import {admin,audit,id,lock,required,TrackerError,type SQL} from './tracker-common.js';
import {minor,decimalToMinor} from '../../src/lib/exact-commission.js';
import {resolveDirectoryTokens} from './ghl-directory.js';
import {gatewayPage,readGatewayEnabled} from './kleegr-read.js';
import {safeDestination} from './tracker-attribution.js';
import {reconcileProductLinks} from './product-links.js';

export interface ProductLineItem {productId:string;name:string;qty:number;unitPriceMinor:string;billingKind:string}
const BILLING_KINDS=['one_time','recurring','setup'];
const str=(v:unknown)=>typeof v==='string'?v.trim():'';
const cur=(v:unknown,fallback:string):string=>{const s=String(v??'').trim().toUpperCase();if(!s)return fallback;if(!/^[A-Z]{3}$/.test(s))throw new TrackerError('invalid_currency','Currency must be a 3-letter ISO code.');return s;};

async function workspaceCurrency(db:SQL,tenantId:string):Promise<string>{const w=(await db.query('SELECT currency FROM tracker_workspaces WHERE tenant_id=$1',[tenantId])).rows[0];return w?.currency||'USD';}
// Per-product commission config + tracking destination. commission-on-purchase is
// a later wave; here we validate + persist the payout terms and the buy page a
// tracking link sends buyers to. destinationUrl reuses safeDestination (HTTPS,
// no credentials, no private hosts) and may be empty.
const intInRange=(v:unknown,name:string,min:number,max:number):number=>{const n=Number(v??0);if(!Number.isInteger(n)||n<min||n>max)throw new TrackerError('invalid_commission',`${name} must be a whole number between ${min} and ${max}.`);return n;};
function commissionConfig(b:any){
  const commissionType=['none','percent','flat'].includes(String(b.commissionType))?String(b.commissionType):'none';
  const commissionBps=intInRange(b.commissionBps,'Commission percentage (basis points)',0,100000);
  const commissionFlatMinor=minor(String(b.commissionFlatMinor??'0'));if(commissionFlatMinor<0n)throw new TrackerError('invalid_commission','Flat commission must be zero or a positive amount in minor units.');
  const holdDays=intInRange(b.holdDays,'Commission hold days',0,3650);
  const destinationUrl=str(b.destinationUrl)?safeDestination(b.destinationUrl):'';
  return{commissionType,commissionBps,commissionFlatMinor:commissionFlatMinor.toString(),holdDays,destinationUrl};
}

// ---------------------------------------------------------------------------
// Reads (tenant-scoped)
// ---------------------------------------------------------------------------
export async function listProducts(db:SQL,u:SessionUser,f:any={}){
  const values:any[]=[u.tenantId],where=['tenant_id=$1'];const add=(v:any)=>{values.push(v);return`$${values.length}`;};
  if(f.q)where.push(`(name||' '||COALESCE(sku,'')||' '||category||' '||description) ILIKE ${add('%'+String(f.q).slice(0,200)+'%')}`);
  if(f.category)where.push(`category=${add(String(f.category))}`);
  if(f.status)where.push(`status=${add(String(f.status))}`);else where.push("status<>'archived'");
  const base=`FROM products WHERE ${where.join(' AND ')}`,page=Math.max(1,Math.min(100000,Number(f.page)||1)),limit=Math.max(1,Math.min(100,Number(f.limit)||50));
  const total=Number((await db.query(`SELECT count(*)::text AS n ${base}`,values)).rows[0].n);
  const rows=(await db.query(`SELECT * ${base} ORDER BY name, id LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,limit,(page-1)*limit])).rows;
  return{rows,total,page,limit};
}
export async function listAssignments(db:SQL,u:SessionUser,f:any={}){
  const values:any[]=[u.tenantId],where=['a.tenant_id=$1'];const add=(v:any)=>{values.push(v);return`$${values.length}`;};
  if(f.salespersonId)where.push(`a.salesperson_id=${add(String(f.salespersonId))}`);
  if(f.productId)where.push(`a.product_id=${add(String(f.productId))}`);
  const rows=(await db.query(`SELECT a.tenant_id,a.product_id,a.salesperson_id,a.created_at,p.name AS product_name,p.status AS product_status,s.name AS salesperson_name FROM product_assignments a JOIN products p ON p.tenant_id=a.tenant_id AND p.id=a.product_id JOIN salespeople s ON s.tenant_id=a.tenant_id AND s.id=a.salesperson_id WHERE ${where.join(' AND ')} ORDER BY p.name, s.name`,values)).rows;
  return{rows,total:rows.length};
}
export async function campaignStructures(db:SQL,u:SessionUser,f:any={}){
  const campaignId=required(f.campaignId,'Campaign');
  const rows=(await db.query(`SELECT s.product_id,s.plan_version_id,p.name AS product_name,pl.name AS plan_name,v.version AS plan_version FROM campaign_product_structures s JOIN products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id LEFT JOIN plan_versions v ON v.tenant_id=s.tenant_id AND v.id=s.plan_version_id LEFT JOIN commission_plans pl ON pl.tenant_id=v.tenant_id AND pl.id=v.plan_id WHERE s.tenant_id=$1 AND s.campaign_id=$2 ORDER BY p.name`,[u.tenantId,campaignId])).rows;
  const map=rows.map(r=>({productId:r.product_id,planVersionId:r.plan_version_id,productName:r.product_name,planVersionName:r.plan_name?`${r.plan_name} · v${r.plan_version}`:null}));
  return{campaignId,map,rows,total:rows.length};
}

// ---------------------------------------------------------------------------
// Mutations (admin-gated)
// ---------------------------------------------------------------------------
export async function saveProduct(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);
  const name=required(b.name,'Product name',200),sku=str(b.sku)||null,category=str(b.category).slice(0,200),description=str(b.description).slice(0,4000);
  const billingKind=BILLING_KINDS.includes(String(b.billingKind))?String(b.billingKind):'one_time';
  const recurringInterval=str(b.recurringInterval).slice(0,50);
  const currency=cur(b.currency,await workspaceCurrency(db,u.tenantId));
  const priceMinor=minor(String(b.priceMinor??'0'));if(priceMinor<0n)throw new TrackerError('invalid_price','Price must be zero or a positive amount in minor units.');
  const status=['active','inactive','archived'].includes(String(b.status))?String(b.status):'active';
  const cc=commissionConfig(b);
  if(b.id){
    const existing=(await db.query('SELECT id FROM products WHERE tenant_id=$1 AND id=$2',[u.tenantId,b.id])).rows[0];if(!existing)throw new TrackerError('not_found','Product not found.',404);
    await db.query(`UPDATE products SET name=$3,sku=$4,category=$5,description=$6,price_minor=$7,currency=$8,billing_kind=$9,recurring_interval=$10,status=$11,commission_type=$12,commission_bps=$13,commission_flat_minor=$14,commission_hold_days=$15,destination_url=$16,updated_at=now() WHERE tenant_id=$1 AND id=$2`,[u.tenantId,b.id,name,sku,category,description,priceMinor.toString(),currency,billingKind,recurringInterval,status,cc.commissionType,cc.commissionBps,cc.commissionFlatMinor,cc.holdDays,cc.destinationUrl]);
    await audit(db,u,'product',b.id,'updated',{name,priceMinor:priceMinor.toString(),currency,commissionType:cc.commissionType});return{id:b.id,...cc};
  }
  const productId=id('prod');
  await db.query(`INSERT INTO products(tenant_id,id,name,sku,category,description,price_minor,currency,billing_kind,recurring_interval,status,commission_type,commission_bps,commission_flat_minor,commission_hold_days,destination_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[u.tenantId,productId,name,sku,category,description,priceMinor.toString(),currency,billingKind,recurringInterval,status,cc.commissionType,cc.commissionBps,cc.commissionFlatMinor,cc.holdDays,cc.destinationUrl]);
  await audit(db,u,'product',productId,'created',{name,priceMinor:priceMinor.toString(),currency,commissionType:cc.commissionType});return{id:productId,...cc};
}
export async function deleteProduct(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const productId=required(b.id,'Product');
  const r=await db.query("UPDATE products SET status='archived',archived_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status<>'archived' RETURNING id",[u.tenantId,productId]);
  if(!r.rows.length){if(!(await db.query('SELECT id FROM products WHERE tenant_id=$1 AND id=$2',[u.tenantId,productId])).rows.length)throw new TrackerError('not_found','Product not found.',404);return{id:productId,duplicate:true};}
  await audit(db,u,'product',productId,'archived',{});return{id:productId,ok:true};
}
export async function assignProducts(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const salespersonId=required(b.salespersonId,'Salesperson');
  if(!(await db.query('SELECT id FROM salespeople WHERE tenant_id=$1 AND id=$2',[u.tenantId,salespersonId])).rows.length)throw new TrackerError('not_found','Salesperson not found.',404);
  const productIds=[...new Set((Array.isArray(b.productIds)?b.productIds:[]).map((x:any)=>String(x)).filter(Boolean))] as string[];
  if(productIds.length){const found=(await db.query('SELECT id FROM products WHERE tenant_id=$1 AND id=ANY($2::text[])',[u.tenantId,productIds])).rows.map(r=>r.id);const missing=productIds.filter(p=>!found.includes(p));if(missing.length)throw new TrackerError('unknown_product','One or more products do not exist in this workspace.');}
  await db.query('DELETE FROM product_assignments WHERE tenant_id=$1 AND salesperson_id=$2',[u.tenantId,salespersonId]);
  for(const productId of productIds)await db.query('INSERT INTO product_assignments(tenant_id,product_id,salesperson_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[u.tenantId,productId,salespersonId]);
  // Mint/reactivate/deactivate the rep's per-product tracking links to match the
  // new assignment set (stable link_id; removed products keep their inactive row).
  await reconcileProductLinks(db,u,salespersonId,productIds);
  await audit(db,u,'product_assignment',salespersonId,'replaced',{count:productIds.length});return{salespersonId,productIds};
}
export async function setCampaignStructures(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const campaignId=required(b.campaignId,'Campaign');
  if(!(await db.query('SELECT id FROM campaigns WHERE tenant_id=$1 AND id=$2',[u.tenantId,campaignId])).rows.length)throw new TrackerError('not_found','Campaign not found.',404);
  const map=(Array.isArray(b.map)?b.map:[]).map((m:any)=>({productId:String(m?.productId||''),planVersionId:String(m?.planVersionId||'')})).filter((m:{productId:string;planVersionId:string})=>m.productId&&m.planVersionId);
  const seen=new Set<string>();for(const m of map){if(seen.has(m.productId))throw new TrackerError('duplicate_product','Each product may map to at most one plan version per campaign.');seen.add(m.productId);}
  if(map.length){
    const products=(await db.query('SELECT id FROM products WHERE tenant_id=$1 AND id=ANY($2::text[])',[u.tenantId,[...seen]])).rows.map(r=>r.id);const missingP=[...seen].filter(p=>!products.includes(p));if(missingP.length)throw new TrackerError('unknown_product','One or more products do not exist in this workspace.');
    const versionIds=[...new Set(map.map((m:{planVersionId:string})=>m.planVersionId))] as string[];const versions=(await db.query('SELECT id FROM plan_versions WHERE tenant_id=$1 AND id=ANY($2::text[])',[u.tenantId,versionIds])).rows.map(r=>r.id);const missingV=versionIds.filter(v=>!versions.includes(v));if(missingV.length)throw new TrackerError('unknown_plan_version','One or more plan versions do not exist in this workspace.');
  }
  await db.query('DELETE FROM campaign_product_structures WHERE tenant_id=$1 AND campaign_id=$2',[u.tenantId,campaignId]);
  for(const m of map)await db.query('INSERT INTO campaign_product_structures(tenant_id,campaign_id,product_id,plan_version_id) VALUES($1,$2,$3,$4)',[u.tenantId,campaignId,m.productId,m.planVersionId]);
  await audit(db,u,'campaign_structure',campaignId,'replaced',{count:map.length});return{campaignId,map};
}

// ---------------------------------------------------------------------------
// Campaign structure resolver: product-specific plan version wins, else the
// campaign's own default plan_version_id.
// ---------------------------------------------------------------------------
export async function resolveProductStructure(db:SQL,tenantId:string,campaignId:string,productId:string):Promise<string|null>{
  if(campaignId&&productId){const s=(await db.query('SELECT plan_version_id FROM campaign_product_structures WHERE tenant_id=$1 AND campaign_id=$2 AND product_id=$3',[tenantId,campaignId,productId])).rows[0];if(s?.plan_version_id)return s.plan_version_id;}
  if(campaignId){const c=(await db.query('SELECT plan_version_id FROM campaigns WHERE tenant_id=$1 AND id=$2',[tenantId,campaignId])).rows[0];return c?.plan_version_id||null;}
  return null;
}

// ---------------------------------------------------------------------------
// Document line-item validation (shared by /api/documents create + update).
// Throws TrackerError with the exact codes the contract requires:
//   unknown_product | product_not_assigned | price_below_floor
// Returns the normalised line items plus the computed minor-unit total.
// ---------------------------------------------------------------------------
export async function validateDocumentLineItems(db:SQL,tenantId:string,opts:{salespersonId:string|null;enforceAssignment:boolean},raw:unknown):Promise<{items:ProductLineItem[];amountMinor:string}>{
  if(!Array.isArray(raw))return{items:[],amountMinor:'0'};
  const items:ProductLineItem[]=[];let total=0n;
  for(const entry of raw.slice(0,200)){
    const o=(entry&&typeof entry==='object'?entry:{}) as Record<string,unknown>;
    const productId=str(o.productId);if(!productId)throw new TrackerError('unknown_product','Each line item must reference a product.');
    const product=(await db.query('SELECT * FROM products WHERE tenant_id=$1 AND id=$2',[tenantId,productId])).rows[0];
    if(!product)throw new TrackerError('unknown_product','A line item references a product that does not exist in this workspace.');
    if(opts.enforceAssignment){const assigned=(await db.query('SELECT 1 FROM product_assignments WHERE tenant_id=$1 AND product_id=$2 AND salesperson_id=$3',[tenantId,productId,opts.salespersonId||'__none__'])).rows.length;if(!assigned)throw new TrackerError('product_not_assigned','This product is not assigned to you.',403);}
    const qty=Number(o.qty);if(!Number.isInteger(qty)||qty<=0||qty>1000000)throw new TrackerError('invalid_quantity','Line item quantity must be a positive whole number.');
    const unitPriceMinor=minor(String(o.unitPriceMinor??'0'));if(unitPriceMinor<0n)throw new TrackerError('invalid_price','Line item price must not be negative.');
    if(unitPriceMinor<minor(String(product.price_minor)))throw new TrackerError('price_below_floor','Line item price is below the product floor.');
    const name=str(o.name)||product.name;const billingKind=BILLING_KINDS.includes(String(o.billingKind))?String(o.billingKind):product.billing_kind;
    items.push({productId,name,qty,unitPriceMinor:unitPriceMinor.toString(),billingKind});
    total+=BigInt(qty)*unitPriceMinor;
  }
  return{items,amountMinor:total.toString()};
}

// ---------------------------------------------------------------------------
// GHL product sync — reuses the tracker's GHL auth path (read gateway OR the
// location token from resolveDirectoryTokens). GHL-native: prices come from the
// GHL Products/Prices API, never Stripe. Upserts by ghl_product_id.
// ---------------------------------------------------------------------------
const GHL='https://services.leadconnectorhq.com';
interface GhlSyncedProduct{ghlProductId:string;name:string;description:string;priceMinor:string;currency:string;ghlPriceId:string|null;billingKind:string;recurringInterval:string}
/** Fetch products + their default price from GHL for one location. Injectable fetchImpl for tests. */
export async function readGhlProducts(locationId:string,fetchImpl:typeof fetch=fetch,defaultCurrency='USD'):Promise<GhlSyncedProduct[]>{
  const gateway=readGatewayEnabled();
  const tokens=gateway?null:await resolveDirectoryTokens(locationId,fetchImpl);
  const headers:Record<string,string>=gateway?{}:{Authorization:`Bearer ${tokens!.location.accessToken}`,Version:'2021-07-28',accept:'application/json'};
  const ghlGet=async(path:string,params:Record<string,string>)=>{
    if(gateway){
      // The Smart Productivity read gateway routes by resource name, not path.
      // Map the catalog-list call to 'products' and the per-product price call to
      // 'productPrice' (carrying productId), so each reaches the right upstream.
      const isPrice=/\/products\/[^/]+\/price/.test(path);
      const gp:Record<string,string>={...params};
      let resource='products';
      if(isPrice){resource='productPrice';const m=path.match(/\/products\/([^/]+)\/price/);gp.productId=m?m[1]:'';}
      const body=await gatewayPage(locationId,resource,Number(params.offset||0),fetchImpl,gp);return body.payload;
    }
    let r:Response;try{r=await fetchImpl(`${GHL}${path}?${new URLSearchParams(params)}`,{headers,redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new TrackerError('provider_unreachable','GoHighLevel could not be reached to sync products.',502);}
    if(!r.ok)throw new TrackerError(r.status===429?'rate_limited':r.status===403?'scope_required':r.status===401?'ghl_not_connected':'provider_error',r.status===403?'The connected GHL app needs products.readonly and products/prices.readonly access.':'GoHighLevel could not list products.',r.status===429?429:r.status===401?409:502);
    return r.json();
  };
  const out:GhlSyncedProduct[]=[];
  for(let offset=0,page=0;page<100;page++){
    const body:any=await ghlGet('/products/',{locationId,limit:'100',offset:String(offset)});
    const list:any[]=Array.isArray(body?.products)?body.products:Array.isArray(body?.data)?body.data:[];
    if(!list.length)break;
    for(const p of list){
      const ghlProductId=str(p._id||p.id);if(!ghlProductId)continue;
      // Prices may be embedded on the product; otherwise fetch the price list.
      let prices:any[]=Array.isArray(p.prices)?p.prices:[];
      if(!prices.length){try{const pb:any=await ghlGet(`/products/${ghlProductId}/price/`,{locationId,limit:'100'});prices=Array.isArray(pb?.prices)?pb.prices:Array.isArray(pb?.data)?pb.data:[];}catch{prices=[];}}
      const price=prices[0]||null;
      const recurring=price&&(price.type==='recurring'||price.recurring);
      out.push({ghlProductId,name:str(p.name)||'Untitled product',description:str(p.description),priceMinor:price?decimalToMinor(String(price.amount??'0'),2):'0',currency:cur(price?.currency,defaultCurrency),ghlPriceId:price?str(price._id||price.id)||null:null,billingKind:recurring?'recurring':'one_time',recurringInterval:recurring?str(price?.recurring?.interval||price?.interval):''});
    }
    offset+=list.length;if(list.length<100)break;
  }
  return out;
}
export async function syncGhlProducts(db:SQL,u:SessionUser,b:any,reader=readGhlProducts,fetchImpl:typeof fetch=fetch){
  admin(u);await lock(db,u.tenantId);
  const location=(await db.query("SELECT ghl_location_id FROM tenants WHERE id=$1 AND status='active' AND kleegr_connection_status='connected'",[u.tenantId])).rows[0]?.ghl_location_id;
  if(!location)throw new TrackerError('ghl_not_connected','Open this workspace from the connected GoHighLevel sub-account before syncing products.',409);
  const defaultCurrency=await workspaceCurrency(db,u.tenantId);
  let synced:GhlSyncedProduct[];
  try{synced=await reader(location,fetchImpl,defaultCurrency);}
  catch(e:any){if(e instanceof TrackerError)throw e;
    // Surface the real reason instead of a vague provider_error. The most common
    // cause is the connected GoHighLevel app lacking the Products scope — that
    // needs the app's scopes updated + a reconnect; it can't be fixed by retry.
    if(e&&(e.code==='scope_required'||e.code==='gateway_scope_mismatch'))throw new TrackerError('scope_required','Product sync needs Products access. Ask your admin to enable products.readonly and products/prices.readonly on the connected GoHighLevel app, then reconnect this sub-account. You can still add products manually with Add Product.',403);
    if(e&&(e.code==='token_service_not_configured'||e.code==='reconnect_required'||e.code==='location_required'||e.code==='token_rejected'))throw new TrackerError('ghl_not_connected','GoHighLevel access is unavailable. Reconnect this sub-account and retry. You can still add products manually with Add Product.',409);
    if(e&&(e.code==='gateway_unreachable'||e.code==='gateway_not_configured'||e.code==='gateway_error'))throw new TrackerError('provider_unreachable','GoHighLevel could not be reached for the sync. Try again shortly, or add products manually with Add Product.',502);
    throw new TrackerError('provider_error','GoHighLevel could not complete the product sync. You can still add products manually with Add Product.',502);}
  let created=0,updated=0;
  for(const p of synced){
    const existing=(await db.query('SELECT id FROM products WHERE tenant_id=$1 AND ghl_product_id=$2',[u.tenantId,p.ghlProductId])).rows[0];
    if(existing){await db.query('UPDATE products SET name=$3,description=$4,price_minor=$5,currency=$6,billing_kind=$7,recurring_interval=$8,ghl_price_id=$9,updated_at=now() WHERE tenant_id=$1 AND id=$2',[u.tenantId,existing.id,p.name,p.description,p.priceMinor,p.currency,p.billingKind,p.recurringInterval,p.ghlPriceId]);updated++;}
    else{await db.query('INSERT INTO products(tenant_id,id,name,description,price_minor,currency,billing_kind,recurring_interval,status,ghl_product_id,ghl_price_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[u.tenantId,id('prod'),p.name,p.description,p.priceMinor,p.currency,p.billingKind,p.recurringInterval,'active',p.ghlProductId,p.ghlPriceId]);created++;}
  }
  await audit(db,u,'product',u.tenantId,'ghl_synced',{created,updated,total:synced.length});return{created,updated,total:synced.length};
}
