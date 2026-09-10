import type {VercelRequest,VercelResponse} from '@vercel/node';
import {database,TrackerError} from './_lib/tracker-common.js';
import {referralClick} from './_lib/tracker-attribution.js';
import {checkoutContext,registerCheckout,reconcileCheckout} from './_lib/automatic-checkout.js';
export const config={maxDuration:60};
export default async function handler(req:VercelRequest,res:VercelResponse){
 res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Origin');
 if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','Content-Type');return res.status(204).end();}
 if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
 try{
  const b=typeof req.body==='string'?JSON.parse(req.body):req.body||{};if(JSON.stringify(b).length>1500)throw new TrackerError('too_large','Tracking request is too large.');
  const c=b.action==='visit'?(await database.query('SELECT c.* FROM campaign_participants p JOIN campaigns c ON c.tenant_id=p.tenant_id AND c.id=p.campaign_id WHERE p.link_id=$1 AND p.active=true',[String(b.code||'')])).rows[0]:await checkoutContext(database,String(b.clickId||''));
  const origin=String(req.headers.origin||'');if(!c?.destination_url||origin!==new URL(c.destination_url).origin)throw new TrackerError('origin_mismatch','This page is not the campaign destination.',403);
  res.setHeader('Access-Control-Allow-Origin',origin);
  if(!['test','live'].includes(c.tracking_policy?.automation))throw new TrackerError('tracking_disabled','Automatic checkout tracking is not enabled.',409);
  if(b.action==='visit'){if(b.previousClickId&&c.tracking_policy.touch!=='last'){const previous=(await database.query('SELECT id,expires_at FROM referral_clicks WHERE id=$1 AND campaign_id=$2 AND tenant_id=$3 AND expires_at>now()',[b.previousClickId,c.id,c.tenant_id])).rows[0];if(previous)return res.json({clickId:previous.id,expiresAt:new Date(previous.expires_at).getTime()});}const click=await database.transaction(db=>referralClick(db,String(b.code)));return res.json({clickId:click.clickId,expiresAt:Date.now()+Number(c.tracking_policy.windowDays||30)*86400000});}
  if(b.action==='ready'){if(new Date(c.expires_at).getTime()<Date.now())throw new TrackerError('expired_referral','Referral expired.');await database.query("UPDATE campaigns SET verification_status='script_seen' WHERE tenant_id=$1 AND id=$2 AND verification_status IN('configured','unverified')",[c.tenant_id,c.campaign_id]);return res.json({ok:true,expiresAt:new Date(c.expires_at).getTime()});}
  if(b.action!=='order')throw new TrackerError('invalid_action','Unknown tracking action.');
  const registered=await database.transaction(db=>registerCheckout(db,String(b.clickId),b));
  if(['auto_posted','test_calculated'].includes(registered.status))return res.json({status:registered.status});
  const claimed=await database.query("UPDATE tracker_inbox SET payload=payload||jsonb_build_object('lastCheckedAt',now()) WHERE tenant_id=$1 AND id=$2 AND (payload->>'lastCheckedAt' IS NULL OR (payload->>'lastCheckedAt')::timestamptz<now()-interval '15 seconds') RETURNING id",[registered.tenantId,registered.id]);if(!claimed.rows.length)return res.status(202).json({status:'verification_pending'});
  try{return res.json(await reconcileCheckout(database,registered.tenantId,registered.id));}catch(e){await database.query('UPDATE tracker_inbox SET reason=$3 WHERE tenant_id=$1 AND id=$2',[registered.tenantId,registered.id,e instanceof Error?e.message.slice(0,500):'Verification needs review']);return res.status(202).json({status:'verification_pending'});}
 }catch(e){return res.status(e instanceof TrackerError?e.status:400).json({error:e instanceof TrackerError?e.code:'invalid_request'});}
}
