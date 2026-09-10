import type {VercelRequest,VercelResponse} from '@vercel/node';
import {database,id} from './_lib/tracker-common.js';
import {hashSecret,matchesSecret,notificationScan,operationsInstalled,queueWelcome} from './_lib/operations.js';
import {sendQueuedEmail} from './_lib/operations-providers.js';
export const config={maxDuration:60};
export default async function handler(req:VercelRequest,res:VercelResponse){
 const secret=process.env.CRON_SECRET||'';if(req.method!=='GET'||secret.length<24||!matchesSecret(String(req.headers.authorization||'').replace(/^Bearer /,''),hashSecret(secret)))return res.status(401).json({error:'unauthorized'});
 res.setHeader('Cache-Control','no-store');if(!await operationsInstalled(database))return res.json({skipped:'migration_required'});
 const start=Date.now();let scanned=0,sent=0,failed=0;
 const configs=(await database.query('SELECT * FROM tracker_provider_config WHERE notifications_enabled=true ORDER BY tenant_id LIMIT 20')).rows;
 for(const c of configs){if(Date.now()-start>35000)break;
  const owner=(await database.query("SELECT id,name,email,role FROM users WHERE tenant_id=$1 AND role IN('owner','admin') AND status='active' ORDER BY id LIMIT 1",[c.tenant_id])).rows[0];if(!owner)continue;
  const u={...owner,tenantId:c.tenant_id,tenantSlug:'',tenantName:'Sales Tracker',salespersonId:null};
  try{await database.transaction(async db=>{await notificationScan(db,u);const notices=(await db.query('SELECT title,body FROM tracker_notices WHERE tenant_id=$1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 20',[c.tenant_id])).rows;if(notices.length&&c.notification_email)await db.query('INSERT INTO tracker_email_outbox(id,tenant_id,recipient,subject,body,event_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,event_key) DO NOTHING',[id('digest'),c.tenant_id,c.notification_email,'Sales Tracker: items needing attention',notices.map(n=>`${n.title}\n${n.body}`).join('\n\n'),`daily:${new Date().toISOString().slice(0,10)}`]);
   const people=(await db.query("SELECT s.id FROM salespeople s WHERE s.tenant_id=$1 AND s.created_at>$2 AND s.status='active' AND s.email<>'' AND NOT EXISTS(SELECT 1 FROM tracker_email_outbox e WHERE e.tenant_id=s.tenant_id AND e.event_key='welcome:'||s.id) ORDER BY s.created_at LIMIT 20",[c.tenant_id,c.updated_at])).rows;for(const p of people)await queueWelcome(db,u,{salespersonId:p.id,message:'Welcome to the sales team. Your administrator will share your campaign instructions, referral links and existing login access.'});});scanned++;
   if(process.env.TRACKER_EMAIL_ENABLED==='1'){const rows=(await database.query("SELECT id FROM tracker_email_outbox WHERE tenant_id=$1 AND status='pending' ORDER BY created_at LIMIT 3",[c.tenant_id])).rows;for(const row of rows){if(Date.now()-start>40000)break;try{await sendQueuedEmail(database,u,{id:row.id});sent++;}catch{failed++;}}}
  }catch{failed++;}
 }
 return res.status(failed?207:200).json({scanned,sent,failed});
}
