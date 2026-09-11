import {campaignActivity} from './_lib/campaign-activity.js';
import {checkSubmissions,submissionTests} from './_lib/source-submissions.js';
import {retryCheckout} from './_lib/automatic-checkout.js';
import {campaignCatalog,loadCampaignPage} from './_lib/campaign-sources.js';
import {DirectoryError} from './_lib/ghl-directory.js';
import type {VercelRequest,VercelResponse} from '@vercel/node';
import {getSessionUser} from './_lib/auth.js';
import {csrfOk} from './_lib/http.js';
import {admin,audit,database,TrackerError} from './_lib/tracker-common.js';
import {operationsInstalled,operationsReady,createSource,rotateSource,reviewEvent,notificationScan,queueWelcome,submitTax,reviewTax,taxDownload,testScenario} from './_lib/operations.js';
import {saveProviderConfig,sendQueuedEmail} from './_lib/operations-providers.js';
import {monthlyPackage,monthRange} from './_lib/report-package.js';
import {gatewayPage,readGatewayEnabled} from './_lib/kleegr-read.js';
import {initiateTransfer,reconcileTransfer} from './_lib/paypal-payouts.js';
export const config={maxDuration:60};
export default async function handler(req:VercelRequest,res:VercelResponse){
 res.setHeader('Cache-Control','no-store');if(!['GET','POST'].includes(req.method||''))return res.status(405).json({error:'method_not_allowed'});
 try{
 const u=await getSessionUser(req);if(!u)return res.status(401).json({error:'unauthorized'});const manager=['owner','admin'].includes(u.role),accountant=u.role==='accountant',resource=String(req.query.resource||'status');
 if(req.method==='GET'&&resource==='status')return res.json({installed:await operationsInstalled(database),admin:manager,accountant,participantId:u.salespersonId,stripe:!!process.env.STRIPE_SECRET_KEY,stripeWebhook:!!process.env.STRIPE_WEBHOOK_SECRET,email:!!process.env.RESEND_API_KEY&&!!process.env.TRACKER_EMAIL_FROM,emailEnabled:process.env.TRACKER_EMAIL_ENABLED==='1',taxEncryption:/^[a-f0-9]{64}$/i.test(process.env.TRACKER_TAX_ENCRYPTION_KEY||''),gateway:process.env.KLEEGR_READ_GATEWAY_ENABLED==='1',paypal:process.env.TRACKER_PAYPAL_TENANT_ID===u.tenantId&&!!process.env.PAYPAL_CLIENT_ID&&!!process.env.PAYPAL_CLIENT_SECRET,payoutMode:process.env.TRACKER_PAYPAL_MODE==='live'?'live':'sandbox',livePayouts:process.env.TRACKER_PAYOUTS_ENABLED==='1'});
 await operationsReady(database);
 if(req.method==='GET'){
  if(resource==='package'){if(!manager&&!accountant)throw new TrackerError('forbidden','Administrator or accountant access is required.',403);const month=String(req.query.month||'');monthRange(month);const bytes=await database.transaction(async db=>{await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const w=(await db.query('SELECT timezone FROM tracker_workspaces WHERE tenant_id=$1',[u.tenantId])).rows[0];if(w)await db.query("SELECT set_config('TimeZone',$1,true)",[w.timezone]);return monthlyPackage(db,{...u,role:'admin'},month);});res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition',`attachment; filename="sales-tracker-${month}.zip"`);return res.send(bytes);}
  if(resource==='taxFile'){const f=await database.transaction(db=>taxDownload(db,u,String(req.query.id||'')));res.setHeader('Content-Type','application/pdf');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);return res.send(f.content);}
  if(resource==='tax'){if(accountant||u.role==='sales_manager')throw new TrackerError('forbidden','Tax records require administrator or participant access.',403);return res.json({rows:(await database.query('SELECT id,salesperson_id,kind,filename,status,review_note,created_at FROM tracker_tax_documents WHERE tenant_id=$1 AND ($2::boolean OR salesperson_id=$3) ORDER BY created_at DESC LIMIT 100',[u.tenantId,manager,u.salespersonId])).rows});}
  if(resource==='campaignActivity')return res.json(await campaignActivity(database,u,req.query));
  admin(u);
  if(resource==='submissionTests')return res.json(await submissionTests(database,u,String(req.query.campaignId||'')));
  if(resource==='transfers')return res.json({rows:(await database.query('SELECT * FROM tracker_transfer_attempts WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',[u.tenantId])).rows});
  if(resource==='campaignCatalog')return res.json(await campaignCatalog(database,u,String(req.query.kind||'funnel'),Math.max(1,Math.min(100,Math.floor(Number(req.query.page)||1)))));
  if(resource==='catalog'){
   if(!readGatewayEnabled())throw new TrackerError('gateway_not_active','Activate the Smart Productivity read gateway first.',409);
   const kind=String(req.query.kind||'funnels');if(!['funnels','forms','surveys','calendars'].includes(kind))throw new TrackerError('invalid_resource','Choose funnels, forms, surveys or calendars.');
   const page=Math.max(1,Math.min(100,Math.floor(Number(req.query.page)||1))),location=(await database.query('SELECT ghl_location_id FROM tenants WHERE id=$1',[u.tenantId])).rows[0]?.ghl_location_id;if(!location)throw new TrackerError('location_required','Open the connected workspace.');
   const pageSize=kind==='surveys'?50:100;const result=await gatewayPage(location,kind,(page-1)*pageSize),payload=result.payload,rows=payload[kind]||payload.data?.[kind]||payload.data;
   if(!Array.isArray(rows))throw new TrackerError('unsupported_response','The provider response needs a mapping update.');
   return res.json({rows:rows.map((r:any)=>({id:r.id||r._id,name:r.name||r.title,url:r.url||null})),page,hasMore:kind==='calendars'?false:rows.length===pageSize});
  }
  if(resource==='checkoutEvents')return res.json({rows:(await database.query("SELECT id,status,reason,created_at,payload->'results' AS results FROM tracker_inbox WHERE tenant_id=$1 AND provider='ghl-checkout' AND payload->>'clickId' IN(SELECT id FROM referral_clicks WHERE tenant_id=$1 AND campaign_id=$2) ORDER BY created_at DESC LIMIT 50",[u.tenantId,String(req.query.campaignId||'')])).rows});
  if(resource==='sources')return res.json({rows:(await database.query('SELECT id,campaign_id,name,kind,url,status,verified_at FROM tracker_sources WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',[u.tenantId])).rows});
  if(resource==='inbox')return res.json({rows:(await database.query('SELECT id,source_id,provider,external_id,kind,payload,status,reason,created_at FROM tracker_inbox WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',[u.tenantId])).rows});
  if(resource==='notices')return res.json({rows:(await database.query('SELECT * FROM tracker_notices WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',[u.tenantId])).rows});
  if(resource==='emails')return res.json({rows:(await database.query('SELECT id,recipient,subject,body,status,last_error,provider_id,created_at FROM tracker_email_outbox WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',[u.tenantId])).rows});
  if(resource==='config')return res.json({config:(await database.query('SELECT * FROM tracker_provider_config WHERE tenant_id=$1',[u.tenantId])).rows[0]||{}});
  if(resource==='logins')return res.json({rows:(await database.query('SELECT id,name,email,role,kleegr_user_id FROM users WHERE tenant_id=$1 AND status=\'active\' ORDER BY name LIMIT 500',[u.tenantId])).rows});
  if(resource==='churn'){const range=monthRange(String(req.query.month||''));const r=(await database.query(`SELECT count(*) FILTER(WHERE started_at<$2::date AND (ended_at IS NULL OR ended_at>=$2::date))::int AS starting_subscriptions,count(*) FILTER(WHERE started_at<$2::date AND ended_at>=$2::date AND ended_at<($3::date+1))::int AS cancelled_from_starting_cohort,count(*)::int AS tracked_subscriptions FROM tracker_subscriptions WHERE tenant_id=$1`,[u.tenantId,range.from,range.to])).rows[0];return res.json({...r,rate:r.starting_subscriptions?r.cancelled_from_starting_cohort/r.starting_subscriptions:null,definition:'Subscriptions active at period start that ended during the month. Based only on received live Stripe subscription events; import historical subscriptions before treating this as complete.'});}
  throw new TrackerError('not_found','Resource not found.',404);
 }
 if(!csrfOk(req))throw new TrackerError('csrf_check_failed','Reload and retry.',403);const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};if(JSON.stringify(body).length>(body.action==='submitTax'?2800000:20000))throw new TrackerError('too_large','Request exceeds the size limit.',413);const b=body.data||{};
 if(body.action==='loadCampaignPage'){admin(u);return res.json(await loadCampaignPage(database,u,b));}
 if(body.action==='checkSubmissions')return res.json(await checkSubmissions(database,u,b));
 if(body.action==='retryCheckout')return res.json(await retryCheckout(database,u,b));
 if(body.action==='sendEmail')return res.json(await sendQueuedEmail(database,u,b));
 if(body.action==='initiateTransfer')return res.json(await initiateTransfer(database,u,b));
 if(body.action==='reconcileTransfer')return res.json(await reconcileTransfer(database,u,b));
 if(body.action==='providerConfig'){admin(u);return res.json(await database.transaction(db=>saveProviderConfig(db,u,b)));}
 const actions:any={createSource,rotateSource,reviewEvent,notificationScan,queueWelcome,submitTax,reviewTax,
  async testScenario(_db:any,user:any,data:any){admin(user);return testScenario(data);},
  async readNotice(db:any,user:any,data:any){admin(user);await db.query('UPDATE tracker_notices SET read_at=now() WHERE tenant_id=$1 AND id=$2',[user.tenantId,data.id]);return{ok:true};},
  async grantAccountant(db:any,user:any,data:any){admin(user);if(data.userId===user.id)throw new TrackerError('invalid_user','Choose a separate existing login.');const found=(await db.query("SELECT id,role,kleegr_user_id FROM users WHERE tenant_id=$1 AND id=$2 AND status='active'",[user.tenantId,data.userId])).rows[0];if(!found||found.kleegr_user_id||['owner','admin'].includes(found.role))throw new TrackerError('invalid_user','Choose an existing local non-admin login; connected GHL roles are managed upstream.');await db.query("UPDATE users SET role='accountant',salesperson_id=NULL WHERE tenant_id=$1 AND id=$2",[user.tenantId,data.userId]);await audit(db,user,'user',data.userId,'accountant_access_granted',{});return{ok:true};}
 };
 if(!actions[body.action])throw new TrackerError('unknown_action','Action not found.');return res.json(await database.transaction(db=>actions[body.action](db,u,b)));
 }catch(e){return res.status((e instanceof TrackerError||e instanceof DirectoryError)?e.status:400).json({error:(e instanceof TrackerError||e instanceof DirectoryError)?e.code:'request_failed',message:(e instanceof TrackerError||e instanceof DirectoryError)?e.message:'The request could not be completed. Check the fields and retry.'});}
}
