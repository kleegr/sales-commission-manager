// /api/products — dedicated endpoint for the tenant-scoped product catalog,
// per-rep assignments and campaign→product→plan-version structures. The SAME
// contracts are also registered on /api/tracker (reads + mutations maps); this
// route is a thin, self-contained alias that later waves (and the frontend) can
// call directly. All data logic lives in _lib/products.ts.
//
//   GET  ?resource=products&q&category&status&page&limit
//   GET  ?resource=productAssignments&salespersonId|productId
//   GET  ?resource=campaignStructures&campaignId
//   POST { action:'saveProduct', data:{ id?, name, sku?, category?, description?, priceMinor, currency?, billingKind?, recurringInterval?, status? } }
//   POST { action:'deleteProduct', data:{ id } }                                    (archive)
//   POST { action:'syncGhlProducts', data:{} }
//   POST { action:'assignProducts', data:{ salespersonId, productIds:string[] } }   (replace-set)
//   POST { action:'setCampaignStructures', data:{ campaignId, map:[{productId,planVersionId}] } } (replace-set)
//
// SECURITY: tenant ALWAYS from the session; reads are tenant-scoped; every
// mutation is admin-gated inside _lib/products.ts. CSRF-checked like /api/tracker.
import type {VercelRequest,VercelResponse} from '@vercel/node';
import {getSessionUser} from './_lib/auth.js';
import {csrfOk} from './_lib/http.js';
import {hasDb} from './_lib/db.js';
import {ensureSchema} from './_lib/repository.js';
import {database,trackerInstalled,TrackerError,type SQL} from './_lib/tracker-common.js';
import {listProducts,listAssignments,campaignStructures,saveProduct,deleteProduct,assignProducts,setCampaignStructures,syncGhlProducts} from './_lib/products.js';

export const config={maxDuration:60};
const reads:Record<string,(db:SQL,u:any,f:any)=>Promise<any>>={products:listProducts,productAssignments:listAssignments,campaignStructures};
const mutations:Record<string,(db:SQL,u:any,b:any)=>Promise<any>>={saveProduct,deleteProduct,syncGhlProducts,assignProducts,setCampaignStructures};

export default async function handler(req:VercelRequest,res:VercelResponse){
  res.setHeader('Cache-Control','no-store');if(!['GET','POST'].includes(req.method||''))return res.status(405).json({error:'method_not_allowed'});
  if(!hasDb())return res.status(503).json({error:'database_not_configured'});
  try{await ensureSchema();const u=await getSessionUser(req);if(!u)return res.status(401).json({error:'unauthorized'});
    if(!await trackerInstalled())throw new TrackerError('migration_required','Sales Tracker requires the reviewed additive database migration.',503);
    if(req.method==='GET'){const resource=String(req.query.resource||'products');const read=reads[resource];if(!read)throw new TrackerError('unknown_resource','This resource is not available.',404);return res.json(await database.transaction(async db=>{await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');return read(db,u,req.query);}));}
    if(!csrfOk(req))return res.status(403).json({error:'csrf_check_failed'});
    const b=typeof req.body==='string'?JSON.parse(req.body):req.body||{};if(JSON.stringify(b).length>200000)throw new TrackerError('too_large','Request is too large.');
    const mutate=mutations[String(b.action||'')];if(!mutate)throw new TrackerError('unknown_action','Action is not available.');
    return res.json(await database.transaction(db=>mutate(db,u,b.data||{})));
  }catch(e){if(e instanceof TrackerError)return res.status(e.status).json({error:e.code,message:e.message});if(e instanceof SyntaxError)return res.status(400).json({error:'invalid_json',message:'Check the submitted fields.'});console.error('[products] Request failed',e instanceof Error?(e.stack??e.message):String(e));return res.status(400).json({error:'request_failed',message:req.method==='GET'?'Data could not be loaded. Please refresh to try again.':'The change could not be saved. Reload current data and retry.'});}
}
