import {nextPaymentCharge} from './payment-charge.js';
import type {SQL} from './tracker-common.js';
import {resolveProductStructure} from './products.js';
import {calculateExact,type EarningsInput} from '../../src/lib/exact-commission.js';
import {billableQty} from '../../src/lib/proposal-suite.js';
import {rowToDocument} from './documents-core.js';

/** Read-only scenario using the same plan engine and per-line order as invoice posting. */
export async function proposalCommissionPreview(db:SQL,row:any){
  const tenant=row.tenant_id,seller=row.salesperson_id,doc=rowToDocument(row);
  if(!doc.lineItems.length)return {sellerMinor:null,totalMinor:null,reason:'Add catalog products to estimate the commission for this proposal.'};
  if(!seller)return {sellerMinor:null,totalMinor:null,reason:'Assign a salesman to estimate commission.'};
  const workspace=(await db.query('SELECT currency,timezone FROM tracker_workspaces WHERE tenant_id=$1',[tenant])).rows[0];
  if(!workspace)return {sellerMinor:null,totalMinor:null,reason:'Configure the commission workspace first.'};
  const clientId=row.client_id||row.created_client_id;
  const client=clientId?(await db.query('SELECT salesperson_id,closer_id FROM clients WHERE tenant_id=$1 AND id=$2',[tenant,clientId])).rows[0]:null;
  const beneficiaries:EarningsInput['beneficiaries']={referrer:seller,owner:client?.salesperson_id||seller,closer:client?.closer_id||undefined};
  const people=(await db.query('SELECT id,parent_salesperson_id FROM salespeople WHERE tenant_id=$1',[tenant])).rows;
  let cursor=people.find(p=>p.id===seller)?.parent_salesperson_id;const seen=new Set([seller]);
  for(let level=1;cursor&&level<=10;level++){
    if(seen.has(cursor))return {sellerMinor:null,totalMinor:null,reason:'Review the referral hierarchy before estimating.'};seen.add(cursor);
    beneficiaries[(level===1?'parent':level===2?'grandparent':`tier_${level}`) as keyof typeof beneficiaries]=cursor;
    cursor=people.find(p=>p.id===cursor)?.parent_salesperson_id;
  }
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:workspace.timezone||'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const charge=clientId?await nextPaymentCharge(db,tenant,clientId,row.id):1;
  let firstLine=true;
  let sellerTotal=0n,total=0n;
  for(const item of doc.lineItems){
    const amount=BigInt(billableQty(item))*BigInt(item.unitPriceMinor);if(!amount)continue;
    const override=row.campaign_id?await resolveProductStructure(db,tenant,row.campaign_id,item.productId):null;
    const versions=override?(await db.query('SELECT config FROM plan_versions WHERE tenant_id=$1 AND id=$2',[tenant,override])).rows:(await db.query(`SELECT v.config FROM plan_assignments a JOIN plan_versions v ON v.tenant_id=a.tenant_id AND v.id=a.plan_version_id WHERE a.tenant_id=$1 AND a.salesperson_id=$2 AND a.effective_from<=$3::date AND (a.effective_to IS NULL OR a.effective_to>=$3::date) AND (a.product_id IS NULL OR a.product_id=$4) AND (a.campaign_id IS NULL OR a.campaign_id=$5)`,[tenant,seller,date,item.productId,row.campaign_id||null])).rows;
    if(versions.length!==1)return {sellerMinor:null,totalMinor:null,reason:'Assign one effective commission plan for each product and campaign to see an estimate.'};
    const input:EarningsInput={event:'payment',amountMinor:amount.toString(),taxMinor:'0',feeMinor:'0',discountMinor:'0',currency:workspace.currency,productId:item.productId,chargeNumber:charge,date,beneficiaries};
    try{const earnings=calculateExact(versions[0].config,input);if(charge===1&&firstLine)earnings.push(...calculateExact(versions[0].config,{...input,event:'sale'}));for(const earning of earnings){total+=BigInt(earning.amountMinor);if(earning.beneficiaryId===seller)sellerTotal+=BigInt(earning.amountMinor);}}catch{return {sellerMinor:null,totalMinor:null,reason:'The effective plan needs review before commission can be estimated.'};}
    firstLine=false;
  }
  return {sellerMinor:sellerTotal.toString(),totalMinor:total.toString(),reason:'Estimate from today’s effective plans, assuming full payment with no tax or fees. Final earnings follow verified receipts.'};
}
