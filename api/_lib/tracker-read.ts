import type {SessionUser} from './auth.js';
import {admin,isAdmin,visibleIds,TrackerError,type SQL} from './tracker-common.js';

export interface ResourceSpec {table:string;columns:string;search:string;scope?:string;admin?:boolean;date?:string}
const resources:Record<string,ResourceSpec>={
  directory:{table:'external_users',columns:'r.*,s.id AS participant_id',search:"r.name||' '||r.email||' '||r.external_id",admin:true},
  people:{table:'salespeople',columns:'r.id,r.name,r.email,r.role,r.status,r.ghl_user_id,r.ghl_role,r.ghl_active,r.ghl_synced_at,r.team_id,r.manager_user_id,r.parent_salesperson_id,r.enrolled_at,r.referral_code',search:"r.name||' '||r.email",scope:'r.id'},
  teams:{table:'teams',columns:'r.*',search:'r.name',admin:true},
  logins:{table:'users',columns:'r.id,r.name,r.email,r.role,r.status,r.salesperson_id',search:"r.name||' '||r.email",admin:true},
  legacyPlans:{table:'commission_plans',columns:'r.*',search:'r.name',admin:true},
  plans:{table:'plan_versions',columns:'r.*,p.name',search:'p.name',scope:'plan'},
  assignments:{table:'plan_assignments',columns:'r.*',search:'r.id',scope:'r.salesperson_id'},
  leads:{table:'clients',columns:'r.id,r.contact_name,r.company_name,r.email,r.phone,r.ghl_contact_id,r.signup_date,r.original_source,r.salesperson_id,r.referrer_id,r.closer_id,r.attribution_method,r.attribution_evidence,r.attribution_status,r.campaign_id,r.customer_since,r.created_at',search:"r.contact_name||' '||r.company_name||' '||r.email",scope:'lead',date:'r.created_at'},
  opportunities:{table:'opportunities',columns:'r.*',search:'r.name',scope:'opportunity',date:'r.created_at'},
  campaigns:{table:'campaigns',columns:'r.*',search:'r.name',scope:'campaign',date:'r.created_at'},
  links:{table:'campaign_participants',columns:'r.*',search:'r.link_id',scope:'r.salesperson_id'},
  payments:{table:'payments',columns:'r.*,EXISTS(SELECT 1 FROM commission_ledger e WHERE e.tenant_id=r.tenant_id AND e.payment_id=r.id) AS has_earnings',search:"r.id||' '||COALESCE(r.event_key,'')||' '||r.notes",scope:'r.salesperson_id',date:'r.payment_date'},
  ledger:{table:'commission_ledger',columns:'r.*',search:"r.id||' '||COALESCE(r.explanation,'')",scope:'r.salesperson_id',date:'r.payment_date'},
  payouts:{table:'payout_batches',columns:"r.*,(SELECT COALESCE(sum(s.amount_minor),0)::text FROM payout_settlements s WHERE s.tenant_id=r.tenant_id AND s.payout_id=r.id AND s.status='confirmed') AS settled_amount_minor",search:'r.id',scope:'r.salesperson_id',date:'r.created_at'},
  settlements:{table:'payout_settlements',columns:'r.*',search:'r.reference',scope:'settlement',date:'r.settled_at'},
  attribution:{table:'attribution_events',columns:'r.*',search:"r.reason||' '||r.evidence",scope:'client',date:'r.occurred_at'},
  reviews:{table:'attribution_reviews',columns:'r.*',search:'r.reason',admin:true,date:'r.created_at'},
  imports:{table:'import_reviews',columns:'r.*',search:"r.external_id||' '||COALESCE(r.reason,'')",admin:true,date:'r.created_at'},
  sync:{table:'sync_runs',columns:'r.id,r.resource,r.status,r.cursor,r.attempts,r.error,r.next_retry_at,r.started_at,r.completed_at',search:'r.resource',admin:true,date:'r.started_at'},
  goals:{table:'goals',columns:'r.*',search:'r.title',scope:'goal',date:'r.created_at'},
  milestones:{table:'milestones',columns:'r.*',search:'r.title',scope:'milestone',date:'r.created_at'},
  media:{table:'media_resources',columns:'r.*',search:'r.title',scope:'media',date:'r.created_at'},
  audit:{table:'audit_logs',columns:'r.*',search:"r.entity_type||' '||r.action",admin:true,date:'r.created_at'},
};
export async function filteredQuery(db:SQL,u:SessionUser,resource:string,f:any={}){
  const s=resources[resource];if(!s)throw new TrackerError('unknown_resource','This resource is not available.',404);if(s.admin)admin(u);
  const values:any[]=[u.tenantId],where=['r.tenant_id=$1'];let join='';
  const add=(value:any)=>{values.push(value);return`$${values.length}`;};
  if(resource==='directory')join=" LEFT JOIN salespeople s ON s.tenant_id=r.tenant_id AND s.ghl_user_id=r.external_id AND r.provider='ghl'";
  if(resource==='plans')join=' JOIN commission_plans p ON p.tenant_id=r.tenant_id AND p.id=r.plan_id';
  const ids=await visibleIds(db,u);
  if(ids){const q=add(ids),leadScope=`(c.salesperson_id=ANY(${q}::text[]) OR c.referrer_id=ANY(${q}::text[]) OR c.closer_id=ANY(${q}::text[]))`;
    if(s.scope==='lead')where.push(`(r.salesperson_id=ANY(${q}::text[]) OR r.referrer_id=ANY(${q}::text[]) OR r.closer_id=ANY(${q}::text[]))`);
    else if(s.scope==='opportunity')where.push(`(r.owner_id=ANY(${q}::text[]) OR r.closer_id=ANY(${q}::text[]) OR EXISTS(SELECT 1 FROM clients c WHERE c.tenant_id=r.tenant_id AND c.id=r.client_id AND ${leadScope}))`);
    else if(s.scope==='client')where.push(`EXISTS(SELECT 1 FROM clients c WHERE c.tenant_id=r.tenant_id AND c.id=r.client_id AND ${leadScope})`);
    else if(s.scope==='campaign')where.push(`EXISTS(SELECT 1 FROM campaign_participants cp WHERE cp.tenant_id=r.tenant_id AND cp.campaign_id=r.id AND cp.salesperson_id=ANY(${q}::text[]) AND cp.active=true)`);
    else if(s.scope==='media')where.push(`r.audience='participants' AND (r.campaign_id IS NULL OR EXISTS(SELECT 1 FROM campaign_participants cp WHERE cp.tenant_id=r.tenant_id AND cp.campaign_id=r.campaign_id AND cp.salesperson_id=ANY(${q}::text[]) AND cp.active=true))`);
    else if(s.scope==='settlement')where.push(`EXISTS(SELECT 1 FROM payout_batches p WHERE p.tenant_id=r.tenant_id AND p.id=r.payout_id AND p.salesperson_id=ANY(${q}::text[]))`);
    else if(s.scope==='goal')where.push(`(r.salesperson_id=ANY(${q}::text[]) OR (r.team_id IS NOT NULL AND EXISTS(SELECT 1 FROM teams t WHERE t.tenant_id=r.tenant_id AND t.id=r.team_id AND t.manager_user_id=${add(u.id)})))`);
    else if(s.scope==='milestone')where.push(`EXISTS(SELECT 1 FROM goals g WHERE g.tenant_id=r.tenant_id AND g.id=r.goal_id AND g.salesperson_id=ANY(${q}::text[]))`);
    else if(s.scope==='plan')where.push(`EXISTS(SELECT 1 FROM plan_assignments a WHERE a.tenant_id=r.tenant_id AND a.plan_version_id=r.id AND a.salesperson_id=ANY(${q}::text[]))`);
    else if(s.scope)where.push(`${s.scope}=ANY(${q}::text[])`);else where.push('false');
  }
  if(f.q)where.push(`(${s.search}) ILIKE ${add('%'+String(f.q).slice(0,200)+'%')}`);
  if(f.id)where.push(`r.${resource==='directory'?'external_id':resource==='links'?'link_id':'id'}=${add(String(f.id))}`);
  const periodDate=s.date?(s.date==='r.payment_date'?s.date:`NULLIF(${s.date}::text,'')::timestamptz::date::text`):null;
  if(f.from&&periodDate)where.push(`${periodDate}>=${add(String(f.from))}`);
  if(f.to&&periodDate)where.push(`${periodDate}<=${add(String(f.to))}`);
  if(f.status&&resource==='payments')where.push(`r.receipt_status=${add(String(f.status))}`);
  if(f.status&&resource==='directory')where.push(`r.active=${add(f.status==='active')}`);
  if(f.status&&['people','leads','opportunities','campaigns','payouts','ledger','reviews','imports','goals','sync'].includes(resource))where.push(`r.${resource==='leads'?'attribution_status':'status'}=${add(String(f.status))}`);
  if(f.currency&&['payments','ledger','payouts','opportunities','goals'].includes(resource))where.push(`r.currency=${add(String(f.currency))}`);
  if(f.salespersonId&&resource==='people')where.push(`r.id=${add(String(f.salespersonId))}`);
  if(f.teamId&&resource==='people')where.push(`r.team_id=${add(String(f.teamId))}`);
  if(f.salespersonId&&['payments','ledger','payouts','assignments','goals','links'].includes(resource))where.push(`r.salesperson_id=${add(String(f.salespersonId))}`);
  if(f.campaignId&&['payments','ledger','leads','links','media','assignments'].includes(resource))where.push(`r.campaign_id=${add(String(f.campaignId))}`);
  if(f.planVersionId&&resource==='ledger')where.push(`r.plan_version_id=${add(String(f.planVersionId))}`);
  if(f.clientId&&['payments','ledger','opportunities','attribution','reviews'].includes(resource))where.push(`r.client_id=${add(String(f.clientId))}`);
  if(f.teamId&&['payments','ledger','payouts','assignments'].includes(resource))where.push(`EXISTS(SELECT 1 FROM salespeople sp WHERE sp.tenant_id=r.tenant_id AND sp.id=r.salesperson_id AND sp.team_id=${add(String(f.teamId))})`);
  if(f.teamId&&resource==='leads')where.push(`EXISTS(SELECT 1 FROM salespeople sp WHERE sp.tenant_id=r.tenant_id AND sp.id=r.referrer_id AND sp.team_id=${add(String(f.teamId))})`);
  if(f.teamId&&resource==='opportunities')where.push(`EXISTS(SELECT 1 FROM salespeople sp WHERE sp.tenant_id=r.tenant_id AND sp.id=r.owner_id AND sp.team_id=${add(String(f.teamId))})`);
  if(f.source&&resource==='ledger')where.push(`EXISTS(SELECT 1 FROM payments p WHERE p.tenant_id=r.tenant_id AND p.id=r.payment_id AND p.source=${add(String(f.source))})`);
  if(f.source&&resource==='payments')where.push(`r.source=${add(String(f.source))}`);
  if(f.source&&resource==='leads')where.push(`r.original_source=${add(String(f.source))}`);
  if(f.salespersonId&&resource==='leads')where.push(`r.referrer_id=${add(String(f.salespersonId))}`);
  if(f.salespersonId&&resource==='opportunities')where.push(`r.owner_id=${add(String(f.salespersonId))}`);
  const base=`FROM ${s.table} r ${join} WHERE ${where.join(' AND ')}`;
  return{base,values,columns:s.columns};
}
export async function listResource(db:SQL,u:SessionUser,resource:string,f:any={}){
  const q=await filteredQuery(db,u,resource,f),page=Math.max(1,Math.min(100000,Number(f.page)||1)),limit=Math.max(1,Math.min(100,Number(f.limit)||50));
  const total=Number((await db.query(`SELECT count(*)::text AS n ${q.base}`,q.values)).rows[0].n);
  const key=resource==='directory'?'r.external_id':resource==='links'?'r.link_id':'r.id';
  const rows=(await db.query(`SELECT ${q.columns} ${q.base} ORDER BY ${f.sort==='name'&&['people','directory','teams','opportunities','campaigns','plans','legacyPlans'].includes(resource)?(resource==='plans'?'p.name':'r.name'):key} ${f.direction==='desc'?'DESC':'ASC'}, ${key} LIMIT $${q.values.length+1} OFFSET $${q.values.length+2}`,[...q.values,Math.floor(limit),Math.floor((page-1)*limit)])).rows;
  if(resource==='campaigns')for(const campaign of rows){
    const ids=await visibleIds(db,u);
    campaign.clicks=(await db.query('SELECT count(*)::text AS n FROM referral_clicks WHERE tenant_id=$1 AND campaign_id=$2 AND ($3::text[] IS NULL OR salesperson_id=ANY($3::text[]))',[u.tenantId,campaign.id,ids])).rows[0].n;
    campaign.conversions=(await db.query('SELECT count(*)::text AS n FROM referral_conversions c JOIN referral_clicks k ON k.id=c.click_id WHERE c.tenant_id=$1 AND c.campaign_id=$2 AND ($3::text[] IS NULL OR k.salesperson_id=ANY($3::text[]))',[u.tenantId,campaign.id,ids])).rows[0].n;
  }
  if(resource==='goals')for(const goal of rows)goal.progress_minor=await goalProgress(db,u,goal);
  if(resource==='milestones')for(const milestone of rows){const g=(await db.query('SELECT * FROM goals WHERE tenant_id=$1 AND id=$2',[u.tenantId,milestone.goal_id])).rows[0];milestone.progress_minor=g?await goalProgress(db,u,g):null;milestone.achieved=milestone.threshold_minor!==null&&milestone.progress_minor!==null&&BigInt(milestone.progress_minor)>=BigInt(milestone.threshold_minor);}
  await hydrateNames(db,u,rows);
  return{rows,total,page,limit};
}
async function hydrateNames(db:SQL,u:SessionUser,rows:any[]){
  const mappings=[{table:'salespeople',name:'name',fields:['salesperson_id','referrer_id','closer_id','owner_id']},{table:'clients',name:'contact_name',fields:['client_id']},{table:'teams',name:'name',fields:['team_id']}];
  for(const mapping of mappings){const ids=[...new Set(rows.flatMap(r=>mapping.fields.map(f=>r[f]).filter(Boolean)))];if(!ids.length)continue;const names=(await db.query(`SELECT id,${mapping.name} AS name FROM ${mapping.table} WHERE tenant_id=$1 AND id=ANY($2::text[])`,[u.tenantId,ids])).rows;const byId=new Map(names.map(n=>[n.id,n.name]));for(const row of rows)for(const field of mapping.fields)if(row[field])row[field.replace('_id','_name')]=byId.get(row[field])||row[field];}
}
async function goalProgress(db:SQL,u:SessionUser,goal:any){
  if(goal.target_minor===null)return null;
  const owner=goal.metric==='attributed_leads'?'referrer_id':goal.metric==='won_deals'?'closer_id':'salesperson_id';
  const values:any[]=[u.tenantId,goal.period_start,goal.period_end];let scope='';
  if(goal.salesperson_id){values.push(goal.salesperson_id);scope=` AND ${owner}=$4`;}
  else if(goal.team_id){values.push(goal.team_id);scope=` AND ${owner} IN(SELECT id FROM salespeople WHERE tenant_id=$1 AND team_id=$4)`;}
  let sql='';
  if(goal.metric==='attributed_leads')sql=`SELECT count(*)::text AS n FROM clients WHERE tenant_id=$1 AND attribution_at::date>=$2::date AND attribution_at::date<=$3::date AND referrer_id IS NOT NULL${scope}`;
  else if(goal.metric==='won_deals')sql=`SELECT count(*)::text AS n FROM opportunities WHERE tenant_id=$1 AND status='won' AND won_at::date>=$2::date AND won_at::date<=$3::date${scope}`;
  else if(['net_collected','commission_earned'].includes(goal.metric)){values.push(goal.currency);sql=`SELECT COALESCE(sum(amount_minor),0)::text AS n FROM ${goal.metric==='net_collected'?'payments':'commission_ledger'} WHERE tenant_id=$1 AND payment_date>=$2 AND payment_date<=$3 AND currency=$${values.length}${scope} AND ${goal.metric==='net_collected'?"receipt_status='confirmed'":'is_projection=false'}`;}
  return sql?(await db.query(sql,values)).rows[0].n:null;
}
export async function report(db:SQL,u:SessionUser,f:any={}){
  const ledger=await filteredQuery(db,u,'ledger',f),payments=await filteredQuery(db,u,'payments',f);
  const earnings=(await db.query(`SELECT r.currency,COALESCE(sum(r.amount_minor),0)::text AS earned_minor,
    COALESCE(sum(r.amount_minor) FILTER(WHERE r.status='pending' AND r.due_date<=CURRENT_DATE::text AND NOT EXISTS(SELECT 1 FROM payout_reservations pr WHERE pr.tenant_id=r.tenant_id AND pr.entry_id=r.id)),0)::text AS payable_minor,
    COALESCE(sum(r.amount_minor) FILTER(WHERE r.amount_minor<0 AND r.payment_type='refund'),0)::text AS reversed_minor,
    COALESCE(sum(r.amount_minor) FILTER(WHERE r.status IN ('submitted','approved')),0)::text AS reserved_minor,
    COALESCE(sum(r.amount_minor) FILTER(WHERE r.status='paid'),0)::text AS paid_minor,
    COALESCE(sum(r.amount_minor) FILTER(WHERE r.status='pending' AND r.due_date>CURRENT_DATE::text),0)::text AS held_minor,
    COALESCE(sum(r.amount_minor) FILTER(WHERE r.recovery_status='outstanding_offset'),0)::text AS outstanding_offset_minor
    ${ledger.base} AND r.amount_minor IS NOT NULL AND r.is_projection=false GROUP BY r.currency`,ledger.values)).rows;
  const receipts=(await db.query(`SELECT r.currency,COALESCE(sum(r.amount_minor) FILTER(WHERE r.parent_payment_id IS NULL),0)::text AS collected_minor,COALESCE(sum(r.amount_minor) FILTER(WHERE r.parent_payment_id IS NOT NULL),0)::text AS refunded_minor,COALESCE(sum(r.amount_minor),0)::text AS net_collected_minor ${payments.base} AND r.amount_minor IS NOT NULL AND r.receipt_status='confirmed' GROUP BY r.currency`,payments.values)).rows;
  const leads=await filteredQuery(db,u,'leads',f),opps=await filteredQuery(db,u,'opportunities',{...f,from:'',to:''});
  const cohort=(await db.query(`SELECT count(*)::text AS leads,count(*) FILTER(WHERE r.referrer_id IS NOT NULL)::text AS attributed_leads,count(*) FILTER(WHERE r.customer_since IS NOT NULL)::text AS customers ${leads.base}`,leads.values)).rows[0];
  const wonPeriod=[f.from?`r.won_at::date>=$${opps.values.length+1}::date`:'',f.to?`r.won_at::date<=$${opps.values.length+(f.from?2:1)}::date`:''].filter(Boolean);
  const wonValues=[...opps.values,...(f.from?[f.from]:[]),...(f.to?[f.to]:[])];
  const pipeline=(await db.query(`SELECT r.currency,count(*) FILTER(WHERE r.status='open')::text AS open_count,COALESCE(sum(r.value_minor) FILTER(WHERE r.status='open'),0)::text AS open_value_minor,count(*) FILTER(WHERE r.status='won' AND r.won_at IS NOT NULL ${wonPeriod.length?'AND '+wonPeriod.join(' AND '):''})::text AS won_count ${opps.base} GROUP BY r.currency`,wonValues)).rows;
  const byCloser=(await db.query(`SELECT r.closer_id AS id,count(*)::text AS n ${opps.base} AND r.status='won' AND r.won_at IS NOT NULL ${wonPeriod.length?'AND '+wonPeriod.join(' AND '):''} GROUP BY r.closer_id`,wonValues)).rows;
  const generated=await filteredQuery(db,u,'leads',{...f,from:'',to:''});
  // Generation uses attribution date; current ownership is an inventory snapshot, never historical generation.
  const generationPeriod=[f.from?`r.attribution_at::date>=$${generated.values.length+1}::date`:'',f.to?`r.attribution_at::date<=$${generated.values.length+(f.from?2:1)}::date`:''].filter(Boolean);
  const generationValues=[...generated.values,...(f.from?[f.from]:[]),...(f.to?[f.to]:[])];
  const byGenerator=(await db.query(`SELECT r.referrer_id AS id,count(*)::text AS n ${generated.base} AND r.referrer_id IS NOT NULL ${generationPeriod.length?'AND '+generationPeriod.join(' AND '):''} GROUP BY r.referrer_id`,generationValues)).rows;
  const inventory=await filteredQuery(db,u,'leads',{...f,from:'',to:'',salespersonId:''});
  const byOwner=(await db.query(`SELECT r.salesperson_id AS id,count(*)::text AS n ${inventory.base} AND r.salesperson_id IS NOT NULL GROUP BY r.salesperson_id`,inventory.values)).rows;
  const cashByPerson=(await db.query(`SELECT r.salesperson_id AS id,r.currency,sum(r.amount_minor)::text AS amount ${payments.base} AND r.receipt_status='confirmed' AND r.amount_minor IS NOT NULL GROUP BY r.salesperson_id,r.currency`,payments.values)).rows;
  const earningsByPerson=(await db.query(`SELECT r.salesperson_id AS id,r.currency,sum(r.amount_minor)::text AS amount ${ledger.base} AND r.amount_minor IS NOT NULL AND r.is_projection=false GROUP BY r.salesperson_id,r.currency`,ledger.values)).rows;
  const people=await filteredQuery(db,u,'people',f);const names=(await db.query(`SELECT r.id,r.name ${people.base}`,people.values)).rows;
  const performance=names.map(p=>({id:p.id,name:p.name,closed:byCloser.find(r=>r.id===p.id)?.n||'0',generated:byGenerator.find(r=>r.id===p.id)?.n||'0',assigned:byOwner.find(r=>r.id===p.id)?.n||'0',revenue:cashByPerson.filter(r=>r.id===p.id),earnings:earningsByPerson.filter(r=>r.id===p.id)})).sort((a,b)=>Number(b.generated)-Number(a.generated)||a.name.localeCompare(b.name)).slice(0,50);
  const attention=isAdmin(u)?(await db.query(`SELECT (SELECT count(*)::text FROM payout_batches WHERE tenant_id=$1 AND status='submitted') AS pending_approvals,(SELECT count(*)::text FROM import_reviews WHERE tenant_id=$1 AND status='pending') AS pending_imports,(SELECT count(*)::text FROM attribution_reviews WHERE tenant_id=$1 AND status='pending') AS attribution_conflicts,(SELECT count(*)::text FROM sync_runs WHERE tenant_id=$1 AND status='failed') AS failed_syncs`,[u.tenantId])).rows[0]:null;
  const recent=isAdmin(u)?(await db.query('SELECT entity_type,action,created_at FROM audit_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 10',[u.tenantId])).rows:[];
  return{earnings,receipts,cohort,pipeline,performance,attention,recent,definitions:{performance:'Generated leads use attribution dates; assigned leads are current inventory across all dates. Performance shows up to 50 scoped participants ranked by generated leads; receipt revenue uses recorded referrer and currencies remain separate.',period:'Inclusive event dates in the selected range. Paid is the earnings from this event cohort that have subsequently settled, not cash paid during the date range.',earned:'Posted confirmed events plus append-only reversals; projections excluded.',payable:'Due, unreserved pending entries net of reversals. Negative balances remain offsets.',collected:'Confirmed cash receipts before refunds; invoice and opportunity values excluded.',legacy:'Earlier rows without an exact amount remain in their original history and are excluded until separately reviewed.',currency:'Currencies are never combined or converted.',cohort:'Lead cohort uses lead-created dates. Customers are leads in that cohort with a confirmed receipt at any date; conversion numerator is customers and denominator is leads. Open pipeline is a current inventory snapshot. Won deals use a verified won date in the period; imported wins without that date remain excluded from the dated won metric. Neither is collected revenue.'}};
}
export function csvCell(value:unknown):string {let s=typeof value==='object'?JSON.stringify(value):String(value??'');if(/^[\s]*[=+@\-\t\r]/.test(s))s="'"+s;return`"${s.replaceAll('"','""')}"`;}
export async function exportResource(db:SQL,u:SessionUser,resource:string,f:any){
  const q=await filteredQuery(db,u,resource,f);const count=Number((await db.query(`SELECT count(*)::text AS n ${q.base}`,q.values)).rows[0].n);if(count>50000)throw new TrackerError('export_too_large','Narrow filters to 50,000 rows or fewer.');
  let rows:any[]=[];if(['campaigns','goals','milestones'].includes(resource)){for(let page=1;rows.length<count;page++)rows.push(...(await listResource(db,u,resource,{...f,page,limit:100})).rows);}else{rows=(await db.query(`SELECT ${q.columns} ${q.base}`,q.values)).rows;await hydrateNames(db,u,rows);}if(!rows.length)return'No matching records\r\n';const keys=Object.keys(rows[0]);const csv=[keys.map(csvCell).join(','),...rows.map(r=>keys.map(k=>csvCell(r[k])).join(','))].join('\r\n');if(Buffer.byteLength(csv,'utf8')>4000000)throw new TrackerError('export_too_large','This export exceeds the response limit. Narrow the dates or participant filters.');return csv;
}
