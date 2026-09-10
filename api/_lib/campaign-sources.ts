import {createHmac,timingSafeEqual} from 'node:crypto';
import {TrackerError,type SQL} from './tracker-common.js';
import type {SessionUser} from './auth.js';
import {gatewayPage,readGatewayEnabled} from './kleegr-read.js';

export const sourceKinds=['funnel','website','store','form','survey','calendar'];
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const signature=(tenant:string,source:unknown)=>createHmac('sha256',process.env.KLEEGR_TOKEN_SERVICE_KEY||'').update(JSON.stringify(canonical({tenant,source}))).digest('hex');
export function normalizeAssets(payload:any,kind:string,location:string){
 const resource=['funnel','website','store'].includes(kind)?'funnels':`${kind}s`;
 const raw=payload[resource]||payload.data?.[resource]||payload.data;
 if(!Array.isArray(raw))throw new TrackerError('unsupported_response','The provider response needs a mapping update.');
 const rows=raw.filter((r:any)=>(r.id||r._id)&&!r.deleted&&(!r.locationId||r.locationId===location)).filter((r:any)=>resource!=='funnels'||(kind==='store'?r.isStoreActive===true:kind==='website'?r.type==='website':r.type==='funnel'));
 return {rawCount:raw.length,rows:rows.map((r:any)=>({id:String(r.id||r._id),name:String(r.name||r.title||'Untitled'),url:typeof r.url==='string'?r.url:'',pages:(Array.isArray(r.steps)?r.steps:[]).map((p:any)=>({id:String(p.id),name:String(p.name||'Untitled page'),path:String(p.url||''),pageIds:Array.isArray(p.pages)?p.pages.filter((v:any)=>typeof v==='string'):[]}))}))};
}
export async function campaignCatalog(db:SQL,u:SessionUser,kind:string,page:number){
 if(!sourceKinds.includes(kind))throw new TrackerError('invalid_source','Choose a valid source type.');
 if(!readGatewayEnabled())throw new TrackerError('gateway_not_active','The connected asset browser requires the Smart Productivity gateway.',409);
 const location=(await db.query('SELECT ghl_location_id FROM tenants WHERE id=$1',[u.tenantId])).rows[0]?.ghl_location_id;
 if(!location)throw new TrackerError('location_required','Open your connected workspace to browse GHL assets.');
 const resource=['funnel','website','store'].includes(kind)?'funnels':`${kind}s`,size=kind==='survey'?50:100;
 const result=await gatewayPage(location,resource,(page-1)*size),normalized=normalizeAssets(result.payload,kind,location);
 return {page,hasMore:kind!=='calendar'&&normalized.rawCount===size,rows:normalized.rows.map(r=>{
  const selection={kind,id:r.id,name:r.name,pages:r.pages,url:r.url};return {...r,selection,proof:signature(u.tenantId,selection)};
 })};
}
export function validateCampaignSource(tenant:string,b:any,destination:string|null){
 if(!b.source){if(sourceKinds.includes(b.sourceKind))throw new TrackerError('source_required','Select an asset from your connected workspace.');return null;} // Compatibility for existing hosted/manual campaigns.
 const {selection,proof,pageId}=b.source;
 if(!process.env.KLEEGR_TOKEN_SERVICE_KEY||!selection||!sourceKinds.includes(selection.kind)||typeof proof!=='string'||!/^[a-f0-9]{64}$/.test(proof)||!timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(signature(tenant,selection),'hex')))throw new TrackerError('invalid_source','Reload and select an asset from your connected workspace.');
 if(b.conversionMode!=='external'||!destination)throw new TrackerError('invalid_source','Connected assets need a published destination.');
 const pages=selection.pages||[],page=pages.find((p:any)=>p.id===pageId);
 if(['funnel','website','store'].includes(selection.kind)&&!page)throw new TrackerError('landing_page_required','Select the first page visitors should land on.');
 const path=page?.path||selection.url;
 if(path){const expected=new URL(path,'https://placeholder.invalid');const actual=new URL(destination);if(actual.pathname!==expected.pathname||(path.startsWith('https://')&&actual.origin!==expected.origin))throw new TrackerError('landing_page_mismatch','The published URL must point to the selected landing page.');}
 return {selection,proof,pageId:page?.id||null};
}

export async function loadCampaignPage(db:SQL,u:SessionUser,b:any){
 const selected=b.source?.selection,page=selected?.pages?.find((p:any)=>p.id===b.source?.pageId);
 validateCampaignSource(u.tenantId,{source:b.source,conversionMode:'external'},new URL(page?.path||'/', 'https://placeholder.invalid').toString());
 const pageId=page?.pageIds?.[0];if(!pageId)throw new TrackerError('page_required','Refresh the asset list and select a published landing page.');
 const location=(await db.query('SELECT ghl_location_id FROM tenants WHERE id=$1',[u.tenantId])).rows[0]?.ghl_location_id;
 const details=(await gatewayPage(location,'pageDetails',0,fetch,{pageId})).payload;
 if(details.funnelId!==selected.id||details.stepId!==page.id)throw new TrackerError('source_mismatch','Published page does not match this selected funnel step.');
 const selection={...selected,pages:selected.pages.map((p:any)=>p.id===page.id?{...p,path:details.url||p.path}:p),checkout:{pageId,url:details.url,products:details.products}};
 return {source:{selection,proof:signature(u.tenantId,selection),pageId:page.id},destinationUrl:details.url,products:details.products};
}
