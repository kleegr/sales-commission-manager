// ============================================================================
// PER-PRODUCT AFFILIATE TRACKING LINKS  (Sales Commission Manager)
//
// Each PRODUCT carries its own commission (see products.ts). Assigning a product
// to a salesperson mints a stable, unguessable tracking link for that (product,
// rep) pair. Sharing the link and a later purchase auto-credits the rep — the
// commission-on-purchase settlement is a LATER wave; this module owns the link
// lifecycle + the public click capture only.
//
// SEAM for commission-on-purchase: the public /pl/<link_id> redirect appends
// ?ref=<link_id> to the product's destination_url and records the visit in
// product_link_clicks. A later wave maps a paid GHL order back to the rep via
// that ref value (→ product_links row → salesperson_id), and/or by the recorded
// click. link_id is the join key; it never changes once shared.
// ============================================================================
import {randomBytes} from 'node:crypto';
import type {SessionUser} from './auth.js';
import type {SQL} from './tracker-common.js';

// url-safe, unguessable link id (24 random bytes → 32 base64url chars). Reused as
// the ?ref value on the destination, so it must stay within the endpoint guard.
export const newLinkId=()=>randomBytes(24).toString('base64url');
export const LINK_ID_RE=/^[A-Za-z0-9_-]{16,64}$/;

/** Public origin for the shared /pl/<link_id> links. Server-side we derive it the
 * same way the app derives other public links: from the deployment env, falling
 * back to a relative path so the client can prepend window.location.origin. */
export function publicBase(override?:string):string{
  const base=String(override||process.env.PUBLIC_BASE_URL||process.env.APP_BASE_URL||(process.env.VERCEL_URL?`https://${process.env.VERCEL_URL}`:'')||'').trim();
  return base.replace(/\/+$/,'');
}
const linkUrl=(linkId:string,base:string)=>`${base}/pl/${linkId}`;

// ---------------------------------------------------------------------------
// Reconcile product_links for a rep after their product_assignments changed.
// For each assigned product: ensure an ACTIVE link exists — create a fresh
// unguessable link_id if none, else reactivate the existing row KEEPING its
// link_id (shared links never change). For products removed from the rep: flip
// active=false (never delete — a shared link keeps its identity).
// ---------------------------------------------------------------------------
export async function reconcileProductLinks(db:SQL,u:SessionUser,salespersonId:string,productIds:string[]){
  const ids=[...new Set(productIds.map(p=>String(p)).filter(Boolean))];
  await db.query('UPDATE product_links SET active=false WHERE tenant_id=$1 AND salesperson_id=$2 AND active=true AND NOT(product_id=ANY($3::text[]))',[u.tenantId,salespersonId,ids]);
  for(const productId of ids)await db.query('INSERT INTO product_links(tenant_id,link_id,product_id,salesperson_id,active) VALUES($1,$2,$3,$4,true) ON CONFLICT(tenant_id,product_id,salesperson_id) DO UPDATE SET active=true',[u.tenantId,newLinkId(),productId,salespersonId]);
  return{salespersonId,productIds:ids};
}

// ---------------------------------------------------------------------------
// List tracking links (tenant-scoped). Filter by salespersonId and/or productId.
// url = `${base}/pl/<link_id>` where base is the public origin (env-derived).
// ---------------------------------------------------------------------------
export async function listProductLinks(db:SQL,u:SessionUser,f:any={}){
  const values:any[]=[u.tenantId],where=['l.tenant_id=$1'];const add=(v:any)=>{values.push(v);return`$${values.length}`;};
  if(f.salespersonId)where.push(`l.salesperson_id=${add(String(f.salespersonId))}`);
  if(f.productId)where.push(`l.product_id=${add(String(f.productId))}`);
  const rows=(await db.query(`SELECT l.link_id,l.product_id,l.salesperson_id,l.active,l.created_at,p.name AS product_name,p.destination_url,s.name AS salesperson_name FROM product_links l JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id JOIN salespeople s ON s.tenant_id=l.tenant_id AND s.id=l.salesperson_id WHERE ${where.join(' AND ')} ORDER BY p.name, s.name, l.link_id`,values)).rows;
  const base=publicBase(f.base);
  return{rows:rows.map(r=>({...r,url:linkUrl(r.link_id,base)})),total:rows.length};
}

// ---------------------------------------------------------------------------
// Resolve a tracking link by its (globally unique) link_id, with the product's
// destination_url. Used by the public /pl endpoint to decide the redirect.
// ---------------------------------------------------------------------------
export async function resolveProductLink(db:SQL,linkId:string){
  if(!LINK_ID_RE.test(String(linkId||'')))return null;
  return(await db.query('SELECT l.tenant_id,l.link_id,l.product_id,l.salesperson_id,l.active,p.destination_url FROM product_links l JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id WHERE l.link_id=$1',[linkId])).rows[0]||null;
}

// ---------------------------------------------------------------------------
// Record a click on a tracking link. Best-effort + guarded: resolves tenant/
// product/rep from the product_links row, IGNORES unknown or inactive links, and
// silently drops writes past a per-link burst cap so a public URL can't be used
// to flood the table. `ref` (the referer) is accepted for future use.
// ---------------------------------------------------------------------------
const CLICK_BURST_PER_MIN=300;
export async function recordProductLinkClick(db:SQL,linkId:string,ctx:{ip?:string;ref?:string;contactId?:string}={}){
  if(!LINK_ID_RE.test(String(linkId||'')))return{ignored:true};
  const link=(await db.query('SELECT tenant_id,product_id,salesperson_id,active FROM product_links WHERE link_id=$1',[linkId])).rows[0];
  if(!link||!link.active)return{ignored:true};
  const recent=Number((await db.query("SELECT count(*)::text AS n FROM product_link_clicks WHERE link_id=$1 AND created_at>now()-interval '1 minute'",[linkId])).rows[0].n);
  if(recent>=CLICK_BURST_PER_MIN)return{throttled:true};
  await db.query('INSERT INTO product_link_clicks(tenant_id,link_id,product_id,salesperson_id,ip,contact_id) VALUES($1,$2,$3,$4,$5,$6)',[link.tenant_id,linkId,link.product_id,link.salesperson_id,String(ctx.ip||'').slice(0,100),String(ctx.contactId||'').slice(0,200)]);
  return{ok:true,tenantId:link.tenant_id,productId:link.product_id,salespersonId:link.salesperson_id};
}

// ---------------------------------------------------------------------------
// COMMISSION-ON-PURCHASE attribution. Given a purchased product (matched to our
// catalog by ghl_product_id, falling back to our productId) map the sale to the
// rep who should be credited. Resolution order:
//   a. `ref` (the ?ref=<link_id> we append to the destination) resolves to an
//      ACTIVE product_links row IN THIS TENANT whose product is the purchased one;
//   b. else the most-recent product_link_clicks row for that product AND that
//      GHL contact within `windowDays` (default 30) of the sale → its rep;
//   c. else null (no attribution → no commission).
// Tenant-scoped throughout. Read-only.
// ---------------------------------------------------------------------------
export interface ProductSaleAttribution{productId:string;salespersonId:string;linkId:string|null}
export async function attributeProductSale(db:SQL,tenantId:string,opts:{productGhlId?:string;productId?:string;ref?:string;contactId?:string;at?:string|Date;windowDays?:number}):Promise<ProductSaleAttribution|null>{
  // Match the purchased product to OUR catalog: ghl_product_id first, then our id.
  let product:any=null;
  const ghlId=String(opts.productGhlId||'').trim();
  if(ghlId)product=(await db.query('SELECT id FROM products WHERE tenant_id=$1 AND ghl_product_id=$2',[tenantId,ghlId])).rows[0]||null;
  if(!product&&opts.productId)product=(await db.query('SELECT id FROM products WHERE tenant_id=$1 AND id=$2',[tenantId,String(opts.productId)])).rows[0]||null;
  if(!product)return null;
  const productId:string=product.id;
  // a. explicit ref → active link in this tenant for this product
  const ref=String(opts.ref||'').trim();
  if(ref&&LINK_ID_RE.test(ref)){
    const link=await resolveProductLink(db,ref);
    if(link&&link.active&&link.tenant_id===tenantId&&link.product_id===productId)return{productId,salespersonId:link.salesperson_id,linkId:link.link_id};
  }
  // b. most-recent click for this product + this contact within the window
  const contactId=String(opts.contactId||'').trim();
  if(contactId){
    const windowDays=Number.isFinite(Number(opts.windowDays))&&Number(opts.windowDays)>0?Math.floor(Number(opts.windowDays)):30;
    const at=opts.at?new Date(opts.at):new Date();const atIso=isNaN(at.getTime())?new Date().toISOString():at.toISOString();
    const click=(await db.query(`SELECT link_id,salesperson_id FROM product_link_clicks WHERE tenant_id=$1 AND product_id=$2 AND contact_id=$3 AND created_at<=$4::timestamptz AND created_at>=$4::timestamptz-($5::int*interval '1 day') ORDER BY created_at DESC LIMIT 1`,[tenantId,productId,contactId,atIso,windowDays])).rows[0];
    if(click)return{productId,salespersonId:click.salesperson_id,linkId:click.link_id};
  }
  // c. no attribution
  return null;
}
