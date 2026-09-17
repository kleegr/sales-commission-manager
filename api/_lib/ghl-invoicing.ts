// ============================================================================
// GHL-NATIVE INVOICING  —  create+send a GoHighLevel invoice for a document,
// and turn a paid-invoice webhook into automatic per-line-item commission.
//
// GHL-native only (no Stripe). The connected location + its access token are
// resolved the SAME way the rest of the tracker does it (tenant row ->
// resolveDirectoryTokens), never a new auth path. Every read/write is
// TENANT-SCOPED and IDEMPOTENT:
//   - createInvoiceForDocument stores the returned invoice id/status/url on the
//     document; re-running simply overwrites those columns.
//   - applyInvoicePaidEvent posts commission through recordPayment with a stable
//     per-line event key (`proposal:<docId>:<lineIndex>`), so a webhook redelivery
//     never double-posts, and forces the product/campaign structure that
//     resolveProductStructure returns so per-product commission rates actually pay.
//
// The actual GHL HTTP calls live behind an injectable GhlInvoiceClient so tests
// (and the proposal approval flow under test) never touch the network.
// ============================================================================
import type {SessionUser} from './auth.js';
import {TrackerError,type SQL} from './tracker-common.js';
import {resolveProductStructure} from './products.js';
import {resolveDirectoryTokens} from './ghl-directory.js';
import {readGatewayEnabled} from './kleegr-read.js';
import {recordPayment,recordProductCommission} from './tracker-finance.js';
import {attributeProductSale} from './product-links.js';
import {decimalToMinor} from '../../src/lib/exact-commission.js';
import {rowToDocument} from './documents-core.js';

const GHL='https://services.leadconnectorhq.com';
const str=(v:unknown)=>typeof v==='string'?v.trim():'';

// ---------------------------------------------------------------------------
// Injectable GHL invoice client
// ---------------------------------------------------------------------------
export interface InvoiceContact{id:string|null;name:string;email:string;phone:string;companyName:string}
export interface InvoiceItem{name:string;quantity:number;price:number;currency:string}
export interface CreateInvoiceRequest{locationId:string;title:string;name:string;currency:string;contact:InvoiceContact;items:InvoiceItem[];dueDate:string}
export interface CreatedInvoice{invoiceId:string;status:string;url:string|null;contactId:string|null}
export interface GhlInvoiceClient{
  /** Ensure the contact exists (create/lookup if no id), create the invoice, send it, and return the pay link. */
  createAndSend(req:CreateInvoiceRequest):Promise<CreatedInvoice>;
}

// A module-level default so callers (proposal approval, documents.ts) need no
// wiring, while tests swap in a fake with setGhlInvoiceClient(). Mirrors the
// installTestDatabase() pattern used elsewhere in this codebase.
let currentClient:GhlInvoiceClient|null=null;
export function setGhlInvoiceClient(c:GhlInvoiceClient|null){currentClient=c;}
export function activeGhlInvoiceClient():GhlInvoiceClient{return currentClient??liveGhlInvoiceClient();}

async function ghlFetch(path:string,token:string,method:'GET'|'POST',body:unknown,fetchImpl:typeof fetch):Promise<any>{
  let r:Response;
  try{r=await fetchImpl(`${GHL}${path}`,{method,headers:{Authorization:`Bearer ${token}`,Version:'2021-07-28',accept:'application/json','content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(20000),...(method==='GET'||body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw new TrackerError('provider_unreachable','GoHighLevel could not be reached to issue the invoice.',502);}
  if(!r.ok)throw new TrackerError(r.status===429?'rate_limited':r.status===403?'scope_required':r.status===401?'ghl_not_connected':'provider_error',r.status===403?'The connected GHL app needs invoices.write and contacts.write access.':'GoHighLevel could not issue the invoice.',r.status===429?429:r.status===401?409:502);
  try{return await r.json();}catch{return {};}
}

/** The real client: contacts upsert + POST /invoices + POST /invoices/:id/send. Never called in tests. */
export function liveGhlInvoiceClient(fetchImpl:typeof fetch=fetch):GhlInvoiceClient{
  return{
    async createAndSend(req){
      const tokens=await resolveDirectoryTokens(req.locationId,fetchImpl);
      const token=tokens.location.accessToken;
      // 1. Ensure a GHL contact. Upsert is idempotent on (locationId,email).
      let contactId=req.contact.id;
      if(!contactId){
        const [firstName,...rest]=req.contact.name.split(' ');
        const up=await ghlFetch('/contacts/',token,'POST',{locationId:req.locationId,email:req.contact.email,phone:req.contact.phone||undefined,name:req.contact.name||undefined,firstName:firstName||undefined,lastName:rest.join(' ')||undefined,companyName:req.contact.companyName||undefined},fetchImpl);
        contactId=str(up?.contact?.id||up?.id)|| (up?.meta?.contactId?String(up.meta.contactId):null);
      }
      if(!contactId)throw new TrackerError('ghl_contact_failed','GoHighLevel did not return a contact for the invoice recipient.',502);
      // 2. Create the invoice.
      const created=await ghlFetch('/invoices/',token,'POST',{altId:req.locationId,altType:'location',locationId:req.locationId,contactId,name:req.name,title:req.title,currency:req.currency,issueDate:req.dueDate,dueDate:req.dueDate,items:req.items.map(i=>({name:i.name,quantity:i.quantity,price:i.price,currency:i.currency}))},fetchImpl);
      const invoiceId=str(created?._id||created?.id||created?.invoice?._id||created?.invoice?.id);
      if(!invoiceId)throw new TrackerError('ghl_invoice_failed','GoHighLevel did not return an invoice id.',502);
      // 3. Send it so the client gets a hosted pay link.
      let status=str(created?.status)||'draft',url=str(created?.invoiceUrl||created?.url)||null;
      try{const sent=await ghlFetch(`/invoices/${invoiceId}/send`,token,'POST',{altId:req.locationId,altType:'location',userId:'system',action:'sms_and_email'},fetchImpl);
        status=str(sent?.status)||'sent';url=str(sent?.invoiceUrl||sent?.url)||url;}
      catch{/* invoice exists even if the send notification failed; keep the created status */}
      return{invoiceId,status,url,contactId};
    },
  };
}

// ---------------------------------------------------------------------------
// Create + send an invoice for one document (tenant-scoped)
// ---------------------------------------------------------------------------
function minorToMajor(minorStr:string,digits:number):number{
  const neg=minorStr.startsWith('-'),abs=(neg?minorStr.slice(1):minorStr).replace(/^0+(?=\d)/,'')||'0';
  return (neg?-1:1)*Number(abs)/10**digits;
}

export interface DocumentInvoiceResult{invoiceId:string;status:string;url:string|null;contactId:string|null;documentId:string}

/**
 * Load the document + its line items, build a GHL invoice for the client/prospect
 * contact (one invoice item per line item), send it, and store the returned
 * invoice id/status/url on the document. Throws 'ghl_not_connected' when the
 * tenant has no connected GHL location.
 */
export async function createInvoiceForDocument(db:SQL,u:SessionUser,documentId:string,opts:{clientId?:string|null;client?:GhlInvoiceClient}={}):Promise<DocumentInvoiceResult>{
  const row=(await db.query('SELECT * FROM documents WHERE tenant_id=$1 AND id=$2',[u.tenantId,documentId])).rows[0];
  if(!row)throw new TrackerError('not_found','Document not found.',404);
  const location=(await db.query("SELECT ghl_location_id FROM tenants WHERE id=$1 AND status='active' AND kleegr_connection_status='connected'",[u.tenantId])).rows[0]?.ghl_location_id;
  if(!location)throw new TrackerError('ghl_not_connected','Open this workspace from the connected GoHighLevel sub-account before invoicing.',409);
  const w=(await db.query('SELECT currency,payout_terms FROM tracker_workspaces WHERE tenant_id=$1',[u.tenantId])).rows[0];
  const currency=w?.currency||'USD',digits=Number(w?.payout_terms?.minorDigits??2);
  const d=rowToDocument(row);

  // Resolve the recipient contact (client row preferred; fall back to the prospect).
  const clientId=opts.clientId||row.client_id||row.created_client_id||null;
  const client=clientId?(await db.query('SELECT * FROM clients WHERE tenant_id=$1 AND id=$2',[u.tenantId,clientId])).rows[0]:null;
  const contact:InvoiceContact=client
    ?{id:client.ghl_contact_id||null,name:client.contact_name||client.company_name||'',email:client.email||'',phone:client.phone||'',companyName:client.company_name||''}
    :d.prospect?{id:null,name:d.prospect.name,email:d.prospect.email,phone:d.prospect.phone,companyName:d.prospect.company||d.prospect.name}:{id:null,name:'',email:'',phone:'',companyName:''};
  if(!contact.email)throw new TrackerError('recipient_required','The document has no client or prospect email to invoice.',409);

  // One invoice item per line item; fall back to a single item from the document amount.
  const items:InvoiceItem[]=d.lineItems.length
    ?d.lineItems.map(li=>({name:li.name||'Line item',quantity:li.qty,price:minorToMajor(li.unitPriceMinor,digits),currency}))
    :d.amount>0?[{name:d.title||'Amount due',quantity:1,price:d.amount,currency}]:[];
  if(!items.length)throw new TrackerError('no_invoiceable_amount','The document has no line items or amount to invoice.',409);

  const dueDate=new Date().toISOString().slice(0,10);
  const created=await (opts.client||activeGhlInvoiceClient()).createAndSend({locationId:location,title:d.title||'Invoice',name:d.title||'Invoice',currency,contact,items,dueDate});

  await db.query('UPDATE documents SET ghl_invoice_id=$3,ghl_invoice_status=$4,ghl_invoice_url=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2',[u.tenantId,documentId,created.invoiceId,created.status,created.url]);
  // Remember a freshly-created GHL contact id on the client so the next invoice reuses it.
  if(client&&!client.ghl_contact_id&&created.contactId)await db.query('UPDATE clients SET ghl_contact_id=COALESCE(ghl_contact_id,$3) WHERE tenant_id=$1 AND id=$2',[u.tenantId,clientId,created.contactId]);
  return{invoiceId:created.invoiceId,status:created.status,url:created.url,contactId:created.contactId,documentId};
}

// ---------------------------------------------------------------------------
// Paid-invoice webhook -> automatic per-line-item commission
// ---------------------------------------------------------------------------
export interface InvoicePaidEvent{ghlInvoiceId:string;status:string;locationId:string|null}

/**
 * Detect a paid GHL invoice from a (Kleegr-proxied) webhook payload, tolerant of
 * the several shapes/namings GHL uses. Returns null for anything that is not a
 * paid invoice/payment event. Handled: `InvoicePaid` / `invoice.paid`, any
 * invoice event whose payload status is 'paid', and payment events that carry an
 * invoice id and a paid status.
 */
export function parseInvoicePaidEvent(rawType:unknown,payload:any):InvoicePaidEvent|null{
  const t=String(rawType??'').toLowerCase().replace(/[^a-z]/g,'');
  const p=payload&&typeof payload==='object'?payload:{};
  const data=p.data&&typeof p.data==='object'?p.data:p;
  const inv=data.invoice&&typeof data.invoice==='object'?data.invoice:data;
  const ghlInvoiceId=str(inv._id||inv.id||inv.invoiceId||data.invoiceId||p.invoiceId);
  const status=str(inv.status||data.status||p.status).toLowerCase();
  const locationId=str(inv.altId||inv.locationId||data.altId||data.locationId||p.altId||p.locationId)||null;
  const isInvoice=t.includes('invoice');
  const paid=(isInvoice&&t.includes('paid'))||(isInvoice&&status==='paid')||(t.includes('payment')&&status==='paid'&&!!ghlInvoiceId)||(t.includes('order')&&status==='paid'&&!!ghlInvoiceId);
  if(!paid||!ghlInvoiceId)return null;
  return{ghlInvoiceId,status:'paid',locationId};
}

export interface InvoiceApplyResult{applied:boolean;action:string;tenantId:string|null;documentId?:string;lineCount?:number;earnings?:number}

/**
 * Apply a paid GHL invoice: find OUR document by ghl_invoice_id (globally unique,
 * so this is inherently tenant-scoped by the row it lands on), mark it paid, and
 * post ONE confirmed receipt per line item through recordPayment — forcing the
 * product/campaign commission structure via resolveProductStructure. Idempotent:
 * recordPayment dedupes on the per-line event key, so a redelivery posts nothing new.
 */
export async function applyInvoicePaidEvent(db:SQL,event:InvoicePaidEvent):Promise<InvoiceApplyResult>{
  const row=(await db.query('SELECT * FROM documents WHERE ghl_invoice_id=$1',[event.ghlInvoiceId])).rows[0];
  if(!row)return{applied:false,action:'no_document',tenantId:null};
  const tenantId:string=row.tenant_id;
  // Mark the document paid (idempotent).
  await db.query('UPDATE documents SET ghl_invoice_status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',[tenantId,row.id,'paid']);

  const w=(await db.query('SELECT currency,timezone,payout_terms FROM tracker_workspaces WHERE tenant_id=$1',[tenantId])).rows[0];
  const clientId=row.client_id||row.created_client_id||null;
  if(!w||!clientId)return{applied:true,action:'invoice_paid_no_commission',tenantId,documentId:row.id,lineCount:0,earnings:0};
  const currency=w.currency||'USD',digits=Number(w.payout_terms?.minorDigits??2);
  const d=rowToDocument(row),campaignId=d.campaignId||row.campaign_id||null;
  const date=new Date().toISOString().slice(0,10);
  const system:SessionUser={id:`ghl-invoice:${row.id}`,tenantId,tenantSlug:'',tenantName:'',name:'GHL Invoice',email:'',role:'owner',salespersonId:null};

  // Post one confirmed receipt per line item; each carries the product-specific
  // structure so per-product rates pay out. Lines with no product/campaign
  // structure fall back to the participant's ordinary effective assignment.
  const lines=d.lineItems.length?d.lineItems:(d.amount>0?[{productId:'',name:d.title,qty:1,unitPriceMinor:String(BigInt(Math.round(d.amount*10**digits))),billingKind:'one_time'}]:[]);
  let posted=0;
  for(const [index,li] of lines.entries()){
    const amountMinor=(BigInt(li.qty)*BigInt(li.unitPriceMinor)).toString();
    if(BigInt(amountMinor)<=0n)continue;
    const planVersionOverride=campaignId&&li.productId?await resolveProductStructure(db,tenantId,campaignId,li.productId):null;
    await recordPayment(db,system,{
      eventKey:`proposal:${row.id}:${index}`,clientId,date,amountMinor,currency,status:'confirmed',source:'ghl',
      externalId:event.ghlInvoiceId,productId:li.productId||'',campaignId:campaignId||undefined,
      planVersionOverride:planVersionOverride||undefined,
      notes:`GHL invoice ${event.ghlInvoiceId} paid — "${d.title}" line ${index+1} (${li.name||li.productId||'item'}).`,
    },undefined,d.salespersonId?d.id:undefined);
    posted++;
  }
  // Supersede the manual pending fallback receipt (`proposal:<docId>`): the GHL
  // invoice is now the real cash, so leaving it pending would risk a double count.
  await db.query("UPDATE payments SET receipt_status='cancelled',updated_at=now() WHERE tenant_id=$1 AND event_key=$2 AND receipt_status='pending'",[tenantId,`proposal:${row.id}`]);

  return{applied:true,action:'invoice_paid',tenantId,documentId:row.id,lineCount:lines.length,earnings:posted};
}

// ===========================================================================
// PRODUCT-AFFILIATE SALE  ->  commission-on-purchase (per-product program).
//
// A SEPARATE attribution path from the proposal-invoice one above: a GHL PRODUCT
// order/purchase (not one of our documents) paid by a buyer who came through a
// rep's tracking link. We parse the paid order into per-product lines, map each to
// OUR catalog by ghl_product_id, attribute it to a rep via the ?ref link_id or the
// most-recent product-link click for that (product,contact), and post the product's
// own commission through recordProductCommission (idempotent on the order line).
//
// GHL's live order/purchase webhook FIELD NAMES vary by store/version, so the parse
// is deliberately tolerant of the common shapes (order|purchase|payment events with
// a paid/completed status, items|lineItems|products arrays, amount|total|price per
// line, ref in ref|customFields|attributionSource url). The exact production field
// names must be confirmed against a LIVE order; the admin `creditProductSale`
// mutation is the manual fallback when the auto parse misses a field.
// ===========================================================================
export interface ProductSaleLine{productGhlId:string;amountMinor:string;currency:string;orderId:string;contactId:string|null;ref:string|null;locationId:string|null}

const REF_RE=/[?&]ref=([A-Za-z0-9_-]{16,64})/;
function refFromUrl(v:unknown):string|null{const s=str(v);if(!s)return null;const m=s.match(REF_RE);return m?m[1]:null;}
function refFromCustomFields(cf:any):string|null{
  if(!cf)return null;
  if(Array.isArray(cf)){for(const f of cf){const key=str(f?.key||f?.id||f?.name||f?.fieldKey).toLowerCase();if(key.includes('ref')){const v=str(f?.value??f?.fieldValue??f?.field_value);if(v)return refFromUrl(v)||v;}}return null;}
  if(typeof cf==='object'){for(const [k,v] of Object.entries(cf)){if(String(k).toLowerCase().includes('ref')){const s=str(v);if(s)return refFromUrl(s)||s;}}}
  return null;
}
function extractRef(...objs:any[]):string|null{
  for(const o of objs){if(!o||typeof o!=='object')continue;
    for(const k of ['ref','affiliateRef','affiliate_ref','referral','referralRef']){const v=str((o as any)[k]);if(v)return refFromUrl(v)||v;}
    const cf=refFromCustomFields((o as any).customFields)||refFromCustomFields((o as any).custom_fields);if(cf)return cf;
    const src=(o as any).attributionSource||(o as any).lastAttributionSource||(o as any).contact?.attributionSource;
    const fromUrl=refFromUrl(src?.url||src?.landingUrl||src?.referrer||(o as any).url||(o as any).pageUrl);if(fromUrl)return fromUrl;
  }
  return null;
}
/** Tolerant major-unit-decimal → minor (2 dp). Returns '' when unparseable. GHL order
 * amounts are decimal major units; a bare integer is treated as whole units. */
function amtToMinor(v:unknown):string{const s=String(v??'').trim();if(!s||!/^-?\d+(\.\d+)?$/.test(s))return '';try{return decimalToMinor(s,2);}catch{return '';}}
function lineAmountMinor(o:any,qty:number):string{
  for(const k of ['amount','total','totalAmount','subtotal','lineTotal','amountPaid']){const m=amtToMinor(o?.[k]);if(m&&BigInt(m)>0n)return m;}
  for(const k of ['price','unitPrice','unit_price','amountDue']){const m=amtToMinor(o?.[k]);if(m){const total=(BigInt(m)*BigInt(qty>0?qty:1)).toString();if(BigInt(total)>0n)return total;}}
  return '0';
}

/**
 * Parse a paid GHL product order/purchase into per-product sale lines. Returns [] for
 * anything that is not a paid product order. Each line carries the order id, buyer
 * contact id, the ?ref link id (when present) and the location id, so a later step can
 * resolve OUR tenant and rep. Pure/deterministic — no DB, no network.
 */
export function parseProductSaleEvent(rawType:unknown,payload:any):ProductSaleLine[]{
  const t=String(rawType??'').toLowerCase().replace(/[^a-z]/g,'');
  const p=payload&&typeof payload==='object'?payload:{};
  const data=p.data&&typeof p.data==='object'?p.data:p;
  const order=data.order&&typeof data.order==='object'?data.order:data;
  const isOrderLike=t.includes('order')||t.includes('purchase')||t.includes('payment')||t.includes('transaction');
  if(!isOrderLike)return [];
  const status=str(order.status||order.paymentStatus||data.status||p.status).toLowerCase();
  if(!['paid','completed','complete','success','succeeded','fulfilled','won','active'].includes(status))return [];
  const orderId=str(order._id||order.id||order.orderId||order.order_id||data.orderId||p.orderId);
  if(!orderId)return [];
  const contactId=str(order.contactId||order.contact_id||order.contact?._id||order.contact?.id||data.contactId||p.contactId)||null;
  const currencyTop=str(order.currency||order.currencyCode||data.currency||p.currency).toUpperCase();
  const locationId=str(order.altId||order.locationId||order.location_id||data.altId||data.locationId||p.locationId||p.location_id)||null;
  const ref=extractRef(order,data,p,order.contact);
  const items:any[]=Array.isArray(order.items)?order.items:Array.isArray(order.lineItems)?order.lineItems:Array.isArray(order.products)?order.products:Array.isArray(order.orderItems)?order.orderItems:Array.isArray(data.items)?data.items:[];
  const out:ProductSaleLine[]=[];
  for(const it of items){
    const o=it&&typeof it==='object'?it:{};
    const productGhlId=str(o.product?._id||o.product?.id||(typeof o.product==='string'?o.product:'')||o.productId||o.product_id||o._id||o.id);
    if(!productGhlId)continue;
    const qty=Number(o.qty??o.quantity??1)||1;
    const currency=str(o.currency).toUpperCase()||currencyTop||'USD';
    const amountMinor=lineAmountMinor(o,qty);
    out.push({productGhlId,amountMinor,currency,orderId,contactId,ref,locationId});
  }
  // Fallback: a single-product order with no line-item array but a product + total.
  if(!out.length){
    const productGhlId=str(order.productId||order.product_id||order.product?._id||order.product?.id);
    const amountMinor=lineAmountMinor(order,1);
    if(productGhlId&&BigInt(amountMinor)>0n)out.push({productGhlId,amountMinor,currency:currencyTop||'USD',orderId,contactId,ref,locationId});
  }
  return out;
}

export interface ProductSaleApplyResult{applied:boolean;action:string;tenantId:string|null;orderId:string|null;credited:number;skipped:number}

/**
 * Apply parsed product-sale lines: resolve OUR tenant by the order's GHL location id,
 * then for each line attribute it to a rep (attributeProductSale) and post the product's
 * commission (recordProductCommission) with event key `productsale:<orderId>:<productGhlId>`.
 * Idempotent (recordProductCommission dedupes on event_key) and tenant-scoped. Lines with
 * no attribution or no commission are skipped, never posted.
 */
export async function applyProductSaleEvent(db:SQL,lines:ProductSaleLine[],opts:{at?:string}={}):Promise<ProductSaleApplyResult>{
  if(!lines.length)return{applied:false,action:'no_product_lines',tenantId:null,orderId:null,credited:0,skipped:0};
  const orderId=lines.find(l=>l.orderId)?.orderId||null;
  const locationId=lines.find(l=>l.locationId)?.locationId||null;
  const tenant=locationId?(await db.query("SELECT id FROM tenants WHERE ghl_location_id=$1 AND status='active' LIMIT 1",[locationId])).rows[0]:null;
  if(!tenant)return{applied:false,action:'no_tenant',tenantId:null,orderId,credited:0,skipped:lines.length};
  const tenantId:string=tenant.id,at=opts.at||new Date().toISOString().slice(0,10);
  const system:SessionUser={id:`ghl-order:${orderId||'unknown'}`,tenantId,tenantSlug:'',tenantName:'',name:'GHL Order',email:'',role:'owner',salespersonId:null};
  let credited=0,skipped=0;
  for(const line of lines){
    if(!line.productGhlId||BigInt(line.amountMinor||'0')<=0n){skipped++;continue;}
    // Attribution window upper-bound is NOW (clicks precede the sale we're posting); the
    // ledger posting date `at` is separate (it may be a date-only value at midnight).
    const attr=await attributeProductSale(db,tenantId,{productGhlId:line.productGhlId,ref:line.ref||undefined,contactId:line.contactId||undefined});
    if(!attr){skipped++;continue;}
    const clientId=line.contactId?(await db.query('SELECT id FROM clients WHERE tenant_id=$1 AND ghl_contact_id=$2 LIMIT 1',[tenantId,line.contactId])).rows[0]?.id||null:null;
    const res:any=await recordProductCommission(db,system,{tenantId,productId:attr.productId,salespersonId:attr.salespersonId,orderAmountMinor:line.amountMinor,currency:line.currency,eventKey:`productsale:${orderId}:${line.productGhlId}`,at,contactId:line.contactId||undefined,clientId:clientId||undefined,source:'ghl',notes:`GHL order ${orderId} paid — product ${line.productGhlId} credited to rep ${attr.salespersonId}.`});
    if(res&&(res.skipped||res.duplicate))skipped++;else credited++;
  }
  return{applied:true,action:'product_sale',tenantId,orderId,credited,skipped};
}
