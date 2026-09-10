import type {SessionUser} from './auth.js';
import {dateOnly,visibleIds,workspace,type SQL} from './tracker-common.js';

/** Reporting only: test receipts never become payments or payable earnings. */
export async function campaignActivity(db:SQL,u:SessionUser,f:any={}){
 const ids=u.role==='accountant'?null:await visibleIds(db,u),w=await workspace(db,u);
 const values:any[]=[u.tenantId,ids,w.timezone],conditions=['k.tenant_id=$1','$3::text IS NOT NULL','($2::text[] IS NULL OR k.salesperson_id=ANY($2::text[]))'];
 const add=(v:any)=>{values.push(v);return `$${values.length}`;};
 if(f.campaignId)conditions.push(`k.campaign_id=${add(String(f.campaignId))}`);
 if(f.salespersonId)conditions.push(`k.salesperson_id=${add(String(f.salespersonId))}`);
 const common=conditions.join(' AND '),dates:string[]=[];
 if(f.from)dates.push(`(EVENT_DATE AT TIME ZONE $3)::date>=${add(dateOnly(f.from))}::date`);
 if(f.to)dates.push(`(EVENT_DATE AT TIME ZONE $3)::date<=${add(dateOnly(f.to))}::date`);
 const dateFilter=(column:string)=>dates.length?' AND '+dates.join(' AND ').replaceAll('EVENT_DATE',column):'';
 const base=`WITH orders AS (
 SELECT e.id,e.created_at,e.status,e.reason,e.payload->>'orderId' AS order_id,e.payload->>'mode' AS mode,
 k.campaign_id,c.name AS campaign_name,k.salesperson_id,s.name AS salesperson_name,
 e.payload->'orderSummary'->>'customerName' AS customer_name,
 COALESCE(e.payload->'results'->0->>'currency',${add(w.currency)}) AS currency,
 CASE WHEN e.status='test_calculated' THEN COALESCE((SELECT sum((r->>'amountMinor')::numeric) FROM jsonb_array_elements(COALESCE(e.payload->'results','[]')) r),0)
 WHEN e.status='auto_posted' THEN COALESCE((SELECT sum(p.amount_minor) FROM payments p WHERE p.tenant_id=e.tenant_id AND p.receipt_status='confirmed' AND (p.id IN(SELECT r->>'paymentId' FROM jsonb_array_elements(e.payload->'results') r) OR p.parent_payment_id IN(SELECT r->>'paymentId' FROM jsonb_array_elements(e.payload->'results') r))),0) ELSE 0 END AS revenue_minor,
 CASE WHEN e.status='test_calculated' THEN COALESCE((SELECT sum((earning->>'amountMinor')::numeric) FROM jsonb_array_elements(e.payload->'results') r CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r->'earnings','[]')) earning WHERE $2::text[] IS NULL OR earning->>'beneficiaryId'=ANY($2::text[])),0)
 WHEN e.status='auto_posted' THEN COALESCE((SELECT sum(l.amount_minor) FROM commission_ledger l JOIN payments p ON p.tenant_id=l.tenant_id AND p.id=l.payment_id WHERE l.tenant_id=e.tenant_id AND l.is_projection=false AND ($2::text[] IS NULL OR l.salesperson_id=ANY($2::text[])) AND (p.id IN(SELECT r->>'paymentId' FROM jsonb_array_elements(e.payload->'results') r) OR p.parent_payment_id IN(SELECT r->>'paymentId' FROM jsonb_array_elements(e.payload->'results') r))),0) ELSE 0 END AS commission_minor,
 CASE WHEN e.status='test_calculated' THEN COALESCE((SELECT sum((earning->>'amountMinor')::numeric) FROM jsonb_array_elements(e.payload->'results') r CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r->'earnings','[]')) earning WHERE earning->>'beneficiaryId'=k.salesperson_id),0)
 WHEN e.status='auto_posted' THEN COALESCE((SELECT sum(l.amount_minor) FROM commission_ledger l JOIN payments p ON p.tenant_id=l.tenant_id AND p.id=l.payment_id WHERE l.tenant_id=e.tenant_id AND l.is_projection=false AND l.salesperson_id=k.salesperson_id AND (p.id IN(SELECT r->>'paymentId' FROM jsonb_array_elements(e.payload->'results') r) OR p.parent_payment_id IN(SELECT r->>'paymentId' FROM jsonb_array_elements(e.payload->'results') r))),0) ELSE 0 END AS salesperson_commission_minor
 FROM tracker_inbox e JOIN referral_clicks k ON k.tenant_id=e.tenant_id AND k.id=e.payload->>'clickId'
 JOIN campaigns c ON c.tenant_id=k.tenant_id AND c.id=k.campaign_id
 JOIN salespeople s ON s.tenant_id=k.tenant_id AND s.id=k.salesperson_id
 WHERE e.provider='ghl-checkout' AND ${common}${dateFilter('e.created_at')}
 )`;
 const mode=['test','live'].includes(f.mode)?f.mode:null;
 const modeParam=add(mode),filter=`WHERE (${modeParam}::text IS NULL OR mode=${modeParam})`;
 const summary=(await db.query(`${base} SELECT mode,currency,count(*)::int AS orders,count(*) FILTER(WHERE status IN('test_calculated','auto_posted'))::int AS completed,count(*) FILTER(WHERE status NOT IN('test_calculated','auto_posted'))::int AS pending,sum(revenue_minor)::text AS revenue_minor,sum(commission_minor)::text AS commission_minor FROM orders GROUP BY mode,currency`,values.slice(0,-1))).rows;
 const total=Number((await db.query(`${base} SELECT count(*)::int AS n FROM orders ${filter}`,values)).rows[0].n);
 const limit=10,page=Math.max(1,Math.floor(Number(f.page)||1));
 const rows=(await db.query(`${base} SELECT *,revenue_minor::text AS revenue_minor,commission_minor::text AS commission_minor FROM orders ${filter} ORDER BY created_at DESC,id LIMIT ${limit} OFFSET ${Math.min(page-1,100000)*limit}`,values)).rows;
 // Click timestamps differ from order timestamps. Reuse the same scope and date boundaries.
 const clickValues=values.slice(0,-2);
 const clicks=Number((await db.query(`SELECT count(*)::int AS n FROM referral_clicks k WHERE ${common}${dateFilter('k.created_at')}`,clickValues)).rows[0].n);
 const salesmen=f.includeSalesmen==='1'?(await db.query(`${base} SELECT salesperson_id,max(salesperson_name) AS salesperson_name,mode,currency,count(*) FILTER(WHERE status IN('test_calculated','auto_posted'))::int AS completed,count(*) FILTER(WHERE status NOT IN('test_calculated','auto_posted'))::int AS pending,sum(revenue_minor)::text AS revenue_minor,sum(salesperson_commission_minor)::text AS commission_minor FROM orders GROUP BY salesperson_id,mode,currency`,values.slice(0,-1))).rows:undefined;
 const trend=f.includeAnalytics==='1'?(await db.query(`${base} SELECT mode,currency,to_char(created_at AT TIME ZONE $3,'YYYY-MM-DD') AS day,count(*)::int AS orders,sum(revenue_minor)::text AS revenue_minor FROM orders WHERE status IN('test_calculated','auto_posted') GROUP BY mode,currency,day ORDER BY day`,values.slice(0,-1))).rows:undefined;
 return {rows,total,page,limit,clicks,summary,salesmen,trend,timezone:w.timezone};
}
