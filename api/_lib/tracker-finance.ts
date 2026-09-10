import type {SessionUser} from './auth.js';
import {admin,audit,client,dateOnly,id,lock,participant,required,TrackerError,workspace,type SQL} from './tracker-common.js';
import {calculateExact,minor,refundDelta,type EarningsInput,type ExactPlan} from '../../src/lib/exact-commission.js';
const receiptSignature=(b:any)=>JSON.stringify([b.clientId,b.date,b.amountMinor,b.currency,b.status,b.productId||'',b.taxMinor||'0',b.feeMinor||'0',b.discountMinor||'0',b.opportunityId||null,b.source==='ghl'?'ghl':'manual',b.assignmentParticipantId||null,b.confirmUnattributed===true]);

async function ancestry(db:SQL,u:SessionUser,referrer:string,input:EarningsInput){
 const seen=new Set<string>();let cursor:string|null=referrer;
 for(let level=0;cursor&&level<=10;level++){if(seen.has(cursor))throw new TrackerError('hierarchy_cycle','Resolve the referral hierarchy cycle before calculating.');seen.add(cursor);const person=await participant(db,u,cursor);if(level>0){const key=level===1?'parent':level===2?'grandparent':`tier_${level}`;input.beneficiaries[key as keyof typeof input.beneficiaries]=person.id;}cursor=person.parent_salesperson_id;}
}
export async function recordPayment(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const w=await workspace(db,u),eventKey=required(b.eventKey,'Receipt idempotency key',200);
  const duplicate=(await db.query('SELECT * FROM payments WHERE tenant_id=$1 AND event_key=$2',[u.tenantId,eventKey])).rows[0];
  const confirming=duplicate?.receipt_status==='pending'&&b.status==='confirmed'&&b.confirmExisting===true;
  if(confirming&&(duplicate.client_id!==b.clientId||String(duplicate.amount_minor)!==b.amountMinor||duplicate.currency!==b.currency||duplicate.payment_date!==b.date))throw new TrackerError('receipt_mismatch','Confirmation must retain the original receipt identity, amount, currency and date.');
  if(duplicate&&!confirming){if(receiptSignature(JSON.parse(duplicate.financial_inputs.requestFingerprint))!==receiptSignature(b))throw new TrackerError('idempotency_conflict','This receipt key was already used with different financial details.',409);return{id:duplicate.id,duplicate:true};}
  const lead=await client(db,u,required(b.clientId,'Lead')),date=dateOnly(b.date),amount=minor(b.amountMinor);
  if(amount<=0n||b.currency!==w.currency)throw new TrackerError('invalid_amount','Use a positive amount in the workspace currency.');
  if(!['confirmed','failed','pending','cancelled'].includes(b.status))throw new TrackerError('invalid_status','Choose the actual receipt status.');
  if(b.opportunityId && !(await db.query('SELECT id FROM opportunities WHERE tenant_id=$1 AND id=$2 AND client_id=$3',[u.tenantId,b.opportunityId,lead.id])).rows[0])throw new TrackerError('invalid_opportunity','Opportunity must belong to this lead.');
  const source=b.source==='ghl'?'ghl':'manual';
  const productId=String(b.productId||'');
  const chargeNumber=Number((await db.query("SELECT count(*)::text AS n FROM payments WHERE tenant_id=$1 AND client_id=$2 AND receipt_status='confirmed' AND parent_payment_id IS NULL AND financial_inputs->>'productId'=$3",[u.tenantId,lead.id,productId])).rows[0].n)+1;
  const inputs:EarningsInput={event:'payment',amountMinor:amount.toString(),taxMinor:String(b.taxMinor||'0'),feeMinor:String(b.feeMinor||'0'),discountMinor:String(b.discountMinor||'0'),currency:b.currency,productId,chargeNumber,date,beneficiaries:{referrer:lead.referrer_id||undefined,owner:lead.salesperson_id||undefined,closer:lead.closer_id||undefined}};
  if(lead.referrer_id)await ancestry(db,u,lead.referrer_id,inputs);
  if([inputs.taxMinor,inputs.feeMinor,inputs.discountMinor].some(v=>minor(v)<0n)||minor(inputs.taxMinor)+minor(inputs.feeMinor)>amount)throw new TrackerError('invalid_breakdown','Tax and fees must not exceed collected cash.');
  const paymentId=confirming?duplicate.id:id('pay');
  const versions:{version:any;earnings:ReturnType<typeof calculateExact>}[]=[];
  if(b.status==='confirmed'){
    // Explicit referrer is primary. Ownership is never silently treated as lead generation.
    const basis=b.assignmentParticipantId||lead.referrer_id;
    if(basis){await participant(db,u,basis);if(!Object.values(inputs.beneficiaries).includes(basis))throw new TrackerError('invalid_beneficiary','Assignment participant must be an attributed beneficiary of this lead.');
      const candidates=(await db.query(`SELECT v.*,a.id AS assignment_id FROM plan_assignments a JOIN plan_versions v ON v.tenant_id=a.tenant_id AND v.id=a.plan_version_id WHERE a.tenant_id=$1 AND a.salesperson_id=$2 AND a.effective_from<=$3::date AND (a.effective_to IS NULL OR a.effective_to>=$3::date) AND (a.product_id IS NULL OR a.product_id=$4) AND (a.campaign_id IS NULL OR a.campaign_id=$5)`,[u.tenantId,basis,date,productId,lead.campaign_id])).rows;
      if(candidates.length!==1)throw new TrackerError('assignment_required','Assign exactly one effective plan for this participant, product and campaign.',409);
      const version=candidates[0],plan=version.config as ExactPlan;
      const earnings=calculateExact(plan,inputs);
      const firstSale=!(await db.query("SELECT id FROM payments WHERE tenant_id=$1 AND client_id=$2 AND receipt_status='confirmed' AND parent_payment_id IS NULL LIMIT 1",[u.tenantId,lead.id])).rows.length;
      if(firstSale)earnings.push(...calculateExact(plan,{...inputs,event:'sale'}));
      versions.push({version,earnings});
    }else if(!b.confirmUnattributed)throw new TrackerError('attribution_required','Resolve attribution or explicitly record this as an unmatched receipt with no commission.',409);
  }
  if(b.preview)return{preview:true,persisted:false,amountMinor:amount.toString(),currency:b.currency,chargeNumber,earnings:versions.flatMap(v=>v.earnings.map(e=>({...e,planVersionId:v.version.id}))),totalCommissionMinor:versions.flatMap(v=>v.earnings).reduce((a,e)=>a+minor(e.amountMinor),0n).toString()};
  await db.query(`INSERT INTO payments(id,tenant_id,client_id,salesperson_id,payment_date,payment_type,amount,amount_minor,currency,event_key,receipt_status,opportunity_id,campaign_id,source,external_payment_id,payment_number,financial_inputs,notes,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'monthly_subscription',0,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,now(),now()) ON CONFLICT(id) DO UPDATE SET receipt_status=EXCLUDED.receipt_status,salesperson_id=EXCLUDED.salesperson_id,payment_number=EXCLUDED.payment_number,financial_inputs=EXCLUDED.financial_inputs,updated_at=now() WHERE payments.tenant_id=EXCLUDED.tenant_id AND payments.receipt_status='pending'`,[paymentId,u.tenantId,lead.id,lead.referrer_id,date,amount.toString(),b.currency,eventKey,b.status,b.opportunityId||null,lead.campaign_id,source,b.externalId||null,chargeNumber,JSON.stringify({...inputs,requestFingerprint:JSON.stringify(b),planVersionIds:versions.map(v=>v.version.id)}),String(b.notes||'')]);
  for(const {version,earnings} of versions)for(const [index,e] of earnings.entries()){
    const sp=await participant(db,u,e.beneficiaryId);if(sp.status!=='active')throw new TrackerError('inactive_beneficiary','Resolve the inactive participant before posting this earning.');
    await db.query(`INSERT INTO commission_ledger(id,tenant_id,salesperson_id,client_id,payment_id,commission_plan_id,commission_rule_id,payment_date,payment_type,commission_amount,amount_minor,currency,event_key,plan_version_id,applied_inputs,explanation,status,due_date,campaign_id,opportunity_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'receipt',0,$9,$10,$11,$12,$13::jsonb,$14,'pending',$15,$16,$17,now(),now())`,[id('earn'),u.tenantId,e.beneficiaryId,lead.id,paymentId,version.plan_id,e.ruleId,date,e.amountMinor,b.currency,`${eventKey}:${index}`,version.id,JSON.stringify({...e.inputs,plan:version.config,assignmentId:version.assignment_id}),e.explanation,e.dueDate,lead.campaign_id,b.opportunityId||null]);
  }
  if(b.status==='confirmed')await db.query('UPDATE clients SET customer_since=COALESCE(customer_since,$3::timestamptz) WHERE tenant_id=$1 AND id=$2',[u.tenantId,lead.id,date]);
  await audit(db,u,'payment',paymentId,confirming?'receipt_confirmed':'receipt_recorded',{eventKey,status:b.status,amountMinor:amount.toString(),currency:b.currency,earnings:versions.flatMap(v=>v.earnings).length});return{id:paymentId};
}
export async function recordRefund(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const eventKey=required(b.eventKey,'Refund idempotency key',200);
  const duplicate=(await db.query('SELECT id,financial_inputs FROM payments WHERE tenant_id=$1 AND event_key=$2',[u.tenantId,eventKey])).rows[0];
  if(duplicate){if(duplicate.financial_inputs?.requestFingerprint!==JSON.stringify(b))throw new TrackerError('idempotency_conflict','Refund key already used with different details.',409);return{id:duplicate.id,duplicate:true};}
  const parent=(await db.query("SELECT * FROM payments WHERE tenant_id=$1 AND id=$2 AND receipt_status='confirmed' AND parent_payment_id IS NULL AND amount_minor IS NOT NULL FOR UPDATE",[u.tenantId,b.paymentId])).rows[0];
  if(!parent)throw new TrackerError('invalid_receipt','Select a confirmed exact-amount receipt in this workspace.');
  const amount=minor(b.amountMinor),date=dateOnly(b.date),reason=required(b.reason,'Refund reason');
  const previous=(await db.query('SELECT COALESCE(-sum(amount_minor),0)::text AS total FROM payments WHERE tenant_id=$1 AND parent_payment_id=$2',[u.tenantId,parent.id])).rows[0].total;
  refundDelta('0',String(parent.amount_minor),previous,amount.toString());
  const refundId=id('refund');await db.query(`INSERT INTO payments(id,tenant_id,client_id,salesperson_id,payment_date,payment_type,amount,amount_minor,currency,event_key,receipt_status,parent_payment_id,campaign_id,opportunity_id,financial_inputs,notes,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'refund',0,$6,$7,$8,'confirmed',$9,$10,$11,$12::jsonb,$13,now(),now())`,[refundId,u.tenantId,parent.client_id,parent.salesperson_id,date,(-amount).toString(),parent.currency,eventKey,parent.id,parent.campaign_id,parent.opportunity_id,JSON.stringify({requestFingerprint:JSON.stringify(b)}),reason]);
  const earnings=(await db.query('SELECT * FROM commission_ledger WHERE tenant_id=$1 AND payment_id=$2 AND reverses_entry_id IS NULL AND amount_minor IS NOT NULL',[u.tenantId,parent.id])).rows;
  for(const e of earnings){const delta=refundDelta(String(e.amount_minor),String(parent.amount_minor),previous,amount.toString());if(delta==='0')continue;
    await db.query(`INSERT INTO commission_ledger(id,tenant_id,salesperson_id,client_id,payment_id,commission_plan_id,commission_rule_id,payment_date,payment_type,amount_minor,currency,event_key,plan_version_id,applied_inputs,explanation,reverses_entry_id,recovery_status,status,due_date,campaign_id,opportunity_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'refund',$9,$10,$11,$12,$13::jsonb,$14,$15,$16,'pending',$8,$17,$18,now(),now())`,[id('reverse'),u.tenantId,e.salesperson_id,e.client_id,refundId,e.commission_plan_id,e.commission_rule_id,date,delta,e.currency,`${eventKey}:${e.id}`,e.plan_version_id,JSON.stringify({original:e.applied_inputs,originalEarningId:e.id,receiptMinor:parent.amount_minor,priorRefundMinor:previous,refundMinor:amount.toString()}),`Proportional refund of ${e.id}: ${delta} minor units. ${reason}`,e.id,e.status==='paid'?'outstanding_offset':'unpaid_reversal',e.campaign_id,e.opportunity_id]);
  }
  await audit(db,u,'payment',refundId,'refund_recorded',{parentId:parent.id,amountMinor:amount.toString(),reason});return{id:refundId};
}

export async function allocateReceipt(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const reason=required(b.reason,'Late allocation reason');
  const p=(await db.query("SELECT * FROM payments WHERE tenant_id=$1 AND id=$2 AND receipt_status='confirmed' AND parent_payment_id IS NULL AND amount_minor IS NOT NULL",[u.tenantId,b.id])).rows[0];if(!p)throw new TrackerError('invalid_receipt','Select a confirmed receipt.');
  if((await db.query('SELECT id FROM commission_ledger WHERE tenant_id=$1 AND payment_id=$2',[u.tenantId,p.id])).rows.length)throw new TrackerError('already_allocated','This receipt already has posted earnings. Use an adjustment; it cannot be recalculated.',409);
  if((await db.query('SELECT id FROM payments WHERE tenant_id=$1 AND parent_payment_id=$2',[u.tenantId,p.id])).rows.length)throw new TrackerError('refund_review_required','This unmatched receipt has refunds. Review net collection and post an explicit qualified adjustment rather than allocating its original gross amount.');
  const lead=await client(db,u,p.client_id),basis=b.salespersonId||lead.referrer_id;if(!basis||![lead.referrer_id,lead.salesperson_id,lead.closer_id].includes(basis))throw new TrackerError('attribution_required','Resolve the beneficiary before allocating this receipt.');await participant(db,u,basis);
  const versions=(await db.query(`SELECT v.*,a.id AS assignment_id FROM plan_assignments a JOIN plan_versions v ON v.tenant_id=a.tenant_id AND v.id=a.plan_version_id WHERE a.tenant_id=$1 AND a.salesperson_id=$2 AND a.effective_from<=$3::date AND (a.effective_to IS NULL OR a.effective_to>=$3::date) AND (a.product_id IS NULL OR a.product_id=$4) AND (a.campaign_id IS NULL OR a.campaign_id=$5)`,[u.tenantId,basis,p.payment_date,p.financial_inputs.productId||'',p.campaign_id])).rows;
  if(versions.length!==1)throw new TrackerError('assignment_required','Exactly one reviewed assignment must cover the original receipt date.');const v=versions[0];
  const input:EarningsInput={...p.financial_inputs,event:'payment',amountMinor:String(p.amount_minor),currency:p.currency,date:p.payment_date,beneficiaries:{referrer:lead.referrer_id||undefined,owner:lead.salesperson_id||undefined,closer:lead.closer_id||undefined}};
  if(lead.referrer_id)await ancestry(db,u,lead.referrer_id,input);
  const earnings=calculateExact(v.config,input);
  const first=(await db.query("SELECT id FROM payments WHERE tenant_id=$1 AND client_id=$2 AND receipt_status='confirmed' AND parent_payment_id IS NULL ORDER BY created_at,id LIMIT 1",[u.tenantId,lead.id])).rows[0];if(first?.id===p.id)earnings.push(...calculateExact(v.config,{...input,event:'sale'}));
  if(!earnings.length)throw new TrackerError('no_qualifying_rules','No rules qualify for this receipt.');
  if(b.preview)return{preview:true,amountMinor:p.amount_minor,currency:p.currency,chargeNumber:input.chargeNumber,earnings,totalCommissionMinor:earnings.reduce((a,e)=>a+minor(e.amountMinor),0n).toString()};
  for(const [i,e]of earnings.entries()){const sp=await participant(db,u,e.beneficiaryId);if(sp.status!=='active')throw new TrackerError('inactive_beneficiary','Resolve inactive beneficiaries before allocating.');await db.query(`INSERT INTO commission_ledger(id,tenant_id,salesperson_id,client_id,payment_id,commission_plan_id,commission_rule_id,payment_date,payment_type,amount_minor,currency,event_key,plan_version_id,applied_inputs,explanation,status,due_date,campaign_id,opportunity_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'receipt',$9,$10,$11,$12,$13::jsonb,$14,'pending',$15,$16,$17,now(),now())`,[id('allocate'),u.tenantId,e.beneficiaryId,lead.id,p.id,v.plan_id,e.ruleId,p.payment_date,e.amountMinor,p.currency,`allocation:${p.event_key}:${i}`,v.id,JSON.stringify({...e.inputs,plan:v.config,assignmentId:v.assignment_id,lateAllocationReason:reason}),`${e.explanation} Late allocation: ${reason}`,e.dueDate,p.campaign_id,p.opportunity_id]);}
  await db.query('UPDATE payments SET salesperson_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND salesperson_id IS NULL',[u.tenantId,p.id,lead.referrer_id||null]);
  await audit(db,u,'payment',p.id,'late_allocation',{reason,versionId:v.id,entries:earnings.length});return{id:p.id};
}

/** Explicitly qualified lead/fixed compensation awards; never inferred from a forecast or payroll run. */
export async function recordAward(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const w=await workspace(db,u),sp=await participant(db,u,b.salespersonId),date=dateOnly(b.date),reason=required(b.reason,'Qualification evidence');
  if(!['lead','fixed_compensation'].includes(b.event)||sp.status!=='active')throw new TrackerError('invalid_award','Choose an active participant and a supported award event.');
  const version=(await db.query('SELECT * FROM plan_versions WHERE tenant_id=$1 AND id=$2',[u.tenantId,b.versionId])).rows[0];if(!version||version.config.currency!==w.currency||date<new Date(version.effective_from).toISOString().slice(0,10))throw new TrackerError('invalid_version','Choose an effective plan version in this workspace currency.');
  const lead=b.event==='lead'?await client(db,u,b.clientId):null;
  if(!(await db.query(`SELECT id FROM plan_assignments WHERE tenant_id=$1 AND salesperson_id=$2 AND plan_version_id=$3 AND effective_from<=$4::date AND (effective_to IS NULL OR effective_to>=$4::date) AND (product_id IS NULL OR product_id=$5) AND (campaign_id IS NULL OR campaign_id=$6)`,[u.tenantId,sp.id,version.id,date,String(b.productId||''),lead?.campaign_id||null])).rows.length)throw new TrackerError('assignment_required','A qualifying dated assignment is required for this award.');
  if(lead&&lead.referrer_id!==sp.id)throw new TrackerError('attribution_required','A lead award belongs to its explicitly recorded referrer.');
  const periodFrom=b.event==='fixed_compensation'?dateOnly(b.periodFrom):date,periodTo=b.event==='fixed_compensation'?dateOnly(b.periodTo):date;
  if(periodTo<periodFrom)throw new TrackerError('invalid_period','Compensation period end must follow its start.');
  const key=b.event==='lead'?`lead:${lead.id}`:`fixed:${sp.id}:${periodFrom}:${periodTo}`;
  const previous=(await db.query('SELECT id FROM commission_ledger WHERE tenant_id=$1 AND applied_inputs->>\'awardKey\'=$2',[u.tenantId,key])).rows;if(previous.length)return{duplicate:true,ids:previous.map(r=>r.id)};
  if(b.event==='fixed_compensation'&&(await db.query(`SELECT id FROM commission_ledger WHERE tenant_id=$1 AND salesperson_id=$2 AND payment_type='fixed_compensation' AND applied_inputs->>'periodFrom'<=$4 AND applied_inputs->>'periodTo'>=$3`,[u.tenantId,sp.id,periodFrom,periodTo])).rows.length)throw new TrackerError('overlapping_period','A fixed compensation award already covers part of this period.');
  const inputs:EarningsInput={event:b.event,amountMinor:'0',taxMinor:'0',feeMinor:'0',discountMinor:'0',currency:w.currency,productId:String(b.productId||''),chargeNumber:1,date,beneficiaries:{referrer:sp.id,owner:lead?.salesperson_id||sp.id,closer:lead?.closer_id||undefined}};
  await ancestry(db,u,sp.id,inputs);
  const earnings=calculateExact(version.config,inputs);if(!earnings.length)throw new TrackerError('no_qualifying_rules','No rules in this version qualify for this event.');
  const ids:string[]=[];for(const [index,e]of earnings.entries()){if((await participant(db,u,e.beneficiaryId)).status!=='active')throw new TrackerError('inactive_beneficiary','Resolve inactive award beneficiaries before posting.');const earningId=id('award');ids.push(earningId);await db.query(`INSERT INTO commission_ledger(id,tenant_id,salesperson_id,client_id,commission_plan_id,commission_rule_id,payment_date,payment_type,amount_minor,currency,event_key,plan_version_id,applied_inputs,explanation,status,due_date,campaign_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,'pending',$15,$16,now(),now())`,[earningId,u.tenantId,e.beneficiaryId,lead?.id||null,version.plan_id,e.ruleId,date,b.event,e.amountMinor,w.currency,`${key}:${index}`,version.id,JSON.stringify({...inputs,awardKey:key,periodFrom,periodTo,plan:version.config,evidence:reason}),`${e.explanation} Qualification: ${reason}. This is a commission award, not payroll.`,e.dueDate,lead?.campaign_id||null]);}
  await audit(db,u,'award',ids[0],'qualified_award_posted',{event:b.event,periodFrom,periodTo,reason,versionId:version.id});return{ids};
}

export async function recordAdjustment(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const w=await workspace(db,u),sp=await participant(db,u,b.salespersonId),amount=minor(b.amountMinor),date=dateOnly(b.date),reason=required(b.reason,'Adjustment reason'),key=`manual-adjustment:${required(b.eventKey,'Unique adjustment reference')}`;
  if(amount===0n||b.currency!==w.currency)throw new TrackerError('invalid_adjustment','Use a nonzero signed amount in the workspace currency.');
  const existing=(await db.query('SELECT id,amount_minor,salesperson_id FROM commission_ledger WHERE tenant_id=$1 AND event_key=$2',[u.tenantId,key])).rows[0];
  if(existing){if(String(existing.amount_minor)!==amount.toString()||existing.salesperson_id!==sp.id)throw new TrackerError('event_conflict','This adjustment reference already belongs to different details.',409);return{id:existing.id,duplicate:true};}
  const receipt=b.paymentId?(await db.query('SELECT * FROM payments WHERE tenant_id=$1 AND id=$2 AND currency=$3 AND amount_minor IS NOT NULL',[u.tenantId,b.paymentId,w.currency])).rows[0]:null;if(b.paymentId&&!receipt)throw new TrackerError('not_found','Related receipt not found in this workspace currency.');
  const earningId=id('adjustment');await db.query(`INSERT INTO commission_ledger(id,tenant_id,salesperson_id,client_id,payment_date,payment_type,amount_minor,currency,event_key,applied_inputs,explanation,status,due_date,recovery_status,campaign_id,opportunity_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'manual_adjustment',$6,$7,$8,$9::jsonb,$10,'pending',$5,$11,$12,$13,now(),now())`,[earningId,u.tenantId,sp.id,receipt?.client_id||null,date,amount.toString(),w.currency,key,JSON.stringify({manualOverride:true,reason,actorId:u.id,relatedPaymentId:receipt?.id||null,date}),`Authorized signed adjustment: ${reason}. This does not change the original earning or transfer money.`,amount<0n?'outstanding_offset':null,receipt?.campaign_id||null,receipt?.opportunity_id||null]);
  await audit(db,u,'earning',earningId,'manual_adjustment',{reason,amountMinor:amount.toString(),relatedPaymentId:receipt?.id||null});return{id:earningId};
}

export async function createPayout(db:SQL,u:SessionUser,b:any){
  await lock(db,u.tenantId);await participant(db,u,b.salespersonId);await workspace(db,u);
  if(!Array.isArray(b.entryIds)||!b.entryIds.length||b.entryIds.length>1000||new Set(b.entryIds).size!==b.entryIds.length)throw new TrackerError('invalid_entries','Select 1–1000 distinct payable entries.');
  const rows=(await db.query(`SELECT l.* FROM commission_ledger l WHERE l.tenant_id=$1 AND l.salesperson_id=$2 AND l.id=ANY($3::text[]) AND l.status='pending' AND l.is_projection=false AND l.amount_minor IS NOT NULL AND l.due_date<=CURRENT_DATE::text AND NOT EXISTS(SELECT 1 FROM payout_reservations r WHERE r.tenant_id=l.tenant_id AND r.entry_id=l.id) FOR UPDATE`,[u.tenantId,b.salespersonId,b.entryIds])).rows;
  if(rows.length!==b.entryIds.length)throw new TrackerError('entries_unavailable','Some earnings are held, paid, reserved, or outside your scope.',409);
  const currencies=new Set(rows.map(r=>r.currency));if(currencies.size!==1)throw new TrackerError('mixed_currency','A payout must use one currency.');
  // Outstanding negative entries must be included, otherwise they could be bypassed indefinitely.
  const offsets=(await db.query(`SELECT id FROM commission_ledger WHERE tenant_id=$1 AND salesperson_id=$2 AND currency=$3 AND amount_minor<0 AND status='pending' AND due_date<=CURRENT_DATE::text`,[u.tenantId,b.salespersonId,rows[0].currency])).rows;
  if(offsets.some(o=>!b.entryIds.includes(o.id)))throw new TrackerError('offset_required','Include all due negative adjustments for this participant and currency.');
  const total=rows.reduce((a,r)=>a+minor(String(r.amount_minor)),0n);if(total<=0n)throw new TrackerError('no_payable_balance','The selected net balance must be positive. Unrecovered offsets remain outstanding.');
  const payoutId=id('payout');await db.query(`INSERT INTO payout_batches(id,tenant_id,salesperson_id,status,amount_minor,currency,created_by_user_id,created_at,updated_at,notes) VALUES($1,$2,$3,'draft',$4,$5,$6,now(),now(),$7)`,[payoutId,u.tenantId,b.salespersonId,total.toString(),rows[0].currency,u.id,String(b.notes||'')]);
  for(const e of rows){await db.query('INSERT INTO payout_reservations(tenant_id,entry_id,payout_id,amount_minor) VALUES($1,$2,$3,$4)',[u.tenantId,e.id,payoutId,e.amount_minor]);await db.query('INSERT INTO payout_batch_entries(payout_batch_id,commission_entry_id,tenant_id) VALUES($1,$2,$3)',[payoutId,e.id,u.tenantId]);}
  await audit(db,u,'payout',payoutId,'draft_created',{amountMinor:total.toString(),currency:rows[0].currency,entryIds:b.entryIds});return{id:payoutId};
}
export async function transitionPayout(db:SQL,u:SessionUser,b:any){
  await lock(db,u.tenantId);const p=(await db.query('SELECT * FROM payout_batches WHERE tenant_id=$1 AND id=$2 AND amount_minor IS NOT NULL FOR UPDATE',[u.tenantId,b.id])).rows[0];if(!p)throw new TrackerError('not_found','Payout not found.',404);await participant(db,u,p.salesperson_id);
  const action=required(b.action,'Action');let next='';
  if(action==='submit'&&p.status==='draft'){if(p.created_by_user_id!==u.id)admin(u);next='submitted';}
  if(action==='approve'&&p.status==='submitted'){admin(u);const w=await workspace(db,u);if(w.payout_terms.separateApprover!==false&&(p.created_by_user_id===u.id||p.submitted_by_user_id===u.id))throw new TrackerError('separate_approver','A different administrator must approve this payout, including payouts created by an owner.',403);next='approved';}
  if(['reject','cancel'].includes(action)&&['draft','submitted','approved','failed'].includes(p.status)){if(action==='reject'||p.created_by_user_id!==u.id)admin(u);required(b.reason,'Reason');if((await db.query("SELECT id FROM payout_settlements WHERE tenant_id=$1 AND payout_id=$2 AND status IN ('confirmed','unknown') LIMIT 1",[u.tenantId,p.id])).rows.length)throw new TrackerError('settlement_exists','Reconcile the partial or unknown payment before releasing its balance.');next=action==='reject'?'rejected':'cancelled';}
  if(!next)throw new TrackerError('invalid_transition','This action is not allowed from the current payout status.',409);
  await db.query(`UPDATE payout_batches SET status=$3,submitted_by_user_id=CASE WHEN $3='submitted' THEN $4 ELSE submitted_by_user_id END,submitted_at=CASE WHEN $3='submitted' THEN now()::text ELSE submitted_at END,approved_at=CASE WHEN $3='approved' THEN now()::text ELSE approved_at END,approved_by_user_id=CASE WHEN $3='approved' THEN $4 ELSE approved_by_user_id END,updated_at=now() WHERE tenant_id=$1 AND id=$2`,[u.tenantId,p.id,next,u.id]);
  if(['rejected','cancelled'].includes(next)){await db.query('DELETE FROM payout_reservations WHERE tenant_id=$1 AND payout_id=$2',[u.tenantId,p.id]);}
  else await db.query('UPDATE commission_ledger SET status=$3,payout_batch_id=$2 WHERE tenant_id=$1 AND id IN(SELECT entry_id FROM payout_reservations WHERE tenant_id=$1 AND payout_id=$2)',[u.tenantId,p.id,next==='submitted'?'submitted':'approved']);
  if(['rejected','cancelled'].includes(next))await db.query("UPDATE commission_ledger SET status='pending',payout_batch_id=NULL WHERE tenant_id=$1 AND payout_batch_id=$2 AND status<>'paid'",[u.tenantId,p.id]);
  await audit(db,u,'payout',p.id,next,{reason:b.reason||null});return{id:p.id,status:next};
}
export async function settlePayout(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const p=(await db.query('SELECT * FROM payout_batches WHERE tenant_id=$1 AND id=$2 AND amount_minor IS NOT NULL FOR UPDATE',[u.tenantId,b.id])).rows[0];if(!p)throw new TrackerError('not_found','Payout not found.',404);
  const reference=required(b.reference,'Payment reference',200),amount=minor(b.amountMinor),recipient=required(b.recipient,'Recipient'),method=required(b.method,'Payment method',100),date=dateOnly(b.date);
  const existing=(await db.query('SELECT * FROM payout_settlements WHERE tenant_id=$1 AND payout_id=$2 AND reference=$3',[u.tenantId,p.id,reference])).rows[0];
  if(existing && (String(existing.amount_minor)!==amount.toString()||existing.recipient!==recipient||existing.method!==method))throw new TrackerError('reference_conflict','This reference belongs to different settlement details.',409);
  if(existing?.status===b.status)return{id:existing.id,duplicate:true};
  if(!['approved','processing','failed','unknown'].includes(p.status)||!['confirmed','failed','unknown'].includes(b.status)||amount<=0n)throw new TrackerError('invalid_settlement','Record a positive, evidenced settlement against an approved payout.');
  if(existing && (existing.status!=='unknown'||!b.reconciliationReason))throw new TrackerError('reconciliation_required','Only an unknown result may be reconciled; include the evidence and reason.');
  const unknown=(await db.query("SELECT id FROM payout_settlements WHERE tenant_id=$1 AND payout_id=$2 AND status='unknown' AND reference<>$3",[u.tenantId,p.id,reference])).rows;
  if(unknown.length)throw new TrackerError('unknown_result','Reconcile the existing unknown result before adding a new attempt.',409);
  const prior=(await db.query("SELECT COALESCE(sum(amount_minor),0)::text AS total FROM payout_settlements WHERE tenant_id=$1 AND payout_id=$2 AND status='confirmed'",[u.tenantId,p.id])).rows[0].total;
  if(minor(prior)+amount>minor(String(p.amount_minor)))throw new TrackerError('overpayment','Settlement exceeds the remaining batch balance.');
  const settlementId=existing?.id||id('settlement');
  if(existing)await db.query('UPDATE payout_settlements SET status=$4,note=$5,actor_id=$6 WHERE tenant_id=$1 AND payout_id=$2 AND reference=$3',[u.tenantId,p.id,reference,b.status,required(b.reconciliationReason,'Reconciliation reason'),u.id]);
  else await db.query('INSERT INTO payout_settlements(id,tenant_id,payout_id,amount_minor,currency,method,reference,recipient,status,actor_id,settled_at,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[settlementId,u.tenantId,p.id,amount.toString(),p.currency,method,reference,recipient,b.status,u.id,date,String(b.note||'')]);
  const paid=b.status==='confirmed'&&minor(prior)+amount===minor(String(p.amount_minor));const next=paid?'paid':b.status==='confirmed'?'processing':b.status;
  await db.query(`UPDATE payout_batches SET status=$3,reconciliation_status=$4,paid_at=CASE WHEN $3='paid' THEN $5 ELSE paid_at END,paid_by_user_id=CASE WHEN $3='paid' THEN $6 ELSE paid_by_user_id END,updated_at=now() WHERE tenant_id=$1 AND id=$2`,[u.tenantId,p.id,next,paid?'reconciled':b.status==='confirmed'?'partial':b.status,date,u.id]);
  if(paid)await db.query("UPDATE commission_ledger SET status='paid',paid_date=$3,recovery_status=CASE WHEN amount_minor<0 THEN 'offset_applied' ELSE recovery_status END WHERE tenant_id=$1 AND payout_batch_id=$2",[u.tenantId,p.id,date]);
  await audit(db,u,'payout',p.id,'settlement_recorded',{settlementId,reference,amountMinor:amount.toString(),status:b.status,reason:b.reconciliationReason||null});return{id:settlementId,status:next};
}

/** Close a verified partial settlement without rewriting approved amounts or pretending the rest was paid. */
export async function closePartialPayout(db:SQL,u:SessionUser,b:any){
  admin(u);await lock(db,u.tenantId);const reason=required(b.reason,'Reconciliation reason'),date=dateOnly(b.date);
  const p=(await db.query('SELECT * FROM payout_batches WHERE tenant_id=$1 AND id=$2 AND amount_minor IS NOT NULL FOR UPDATE',[u.tenantId,b.id])).rows[0];if(!p)throw new TrackerError('not_found','Payout not found.');if(p.status==='partially_paid')return{id:p.id,duplicate:true};
  if(!['processing','failed'].includes(p.status))throw new TrackerError('invalid_status','Only a verified partial payout can be closed. Reconcile unknown results first.');
  const settlements=(await db.query('SELECT status,amount_minor FROM payout_settlements WHERE tenant_id=$1 AND payout_id=$2',[u.tenantId,p.id])).rows;
  if(settlements.some(s=>s.status==='unknown'))throw new TrackerError('unknown_result','Resolve every unknown settlement before releasing a balance.');
  const paid=settlements.filter(s=>s.status==='confirmed').reduce((a,s)=>a+minor(String(s.amount_minor)),0n),total=minor(String(p.amount_minor)),remaining=total-paid;
  if(paid<=0n||remaining<=0n)throw new TrackerError('not_partial','This batch does not have a verified partial settlement.');
  const entries=(await db.query('SELECT l.* FROM payout_reservations r JOIN commission_ledger l ON l.tenant_id=r.tenant_id AND l.id=r.entry_id WHERE r.tenant_id=$1 AND r.payout_id=$2 ORDER BY l.id',[u.tenantId,p.id])).rows;
  const releases=entries.map(e=>minor(String(e.amount_minor))*remaining/total);let residual=remaining-releases.reduce((a,v)=>a+v,0n);
  // Distribute rounding remainders while keeping every released part within its original signed amount.
  for(let i=0;residual!==0n&&i<entries.length*2;i++){const k=i%entries.length,original=minor(String(entries[k].amount_minor)),delta=residual>0n?1n:-1n,next=releases[k]+delta;if((original>=0n&&next>=0n&&next<=original)||(original<0n&&next<=0n&&next>=original)){releases[k]=next;residual-=delta;}}
  if(residual!==0n)throw new TrackerError('reconciliation_failed','The remaining balance could not be allocated exactly.');
  for(const [index,e]of entries.entries()){
    await db.query("UPDATE commission_ledger SET status='paid',paid_date=$3,recovery_status=CASE WHEN amount_minor<0 THEN 'offset_applied' ELSE recovery_status END WHERE tenant_id=$1 AND id=$2",[u.tenantId,e.id,date]);
    const released=releases[index];if(released===0n)continue;
    for(const kind of ['reclassification','carry_forward']){const earningId=id('balance'),isCarry=kind==='carry_forward',amount=isCarry?released:-released;
      await db.query(`INSERT INTO commission_ledger(id,tenant_id,salesperson_id,client_id,commission_plan_id,commission_rule_id,payment_date,payment_type,amount_minor,currency,event_key,plan_version_id,applied_inputs,explanation,status,due_date,paid_date,payout_batch_id,recovery_status,campaign_id,opportunity_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'balance_reclassification',$8,$9,$10,$11,$12::jsonb,$13,$14,$7,$15,$16,$17,$18,$19,now(),now())`,[earningId,u.tenantId,e.salesperson_id,e.client_id,e.commission_plan_id,e.commission_rule_id,e.payment_date,amount.toString(),e.currency,`partial-close:${p.id}:${e.id}:${kind}`,e.plan_version_id,JSON.stringify({originalInputs:e.applied_inputs,originalEntryId:e.id,payoutId:p.id,kind,reason,reconciledAt:date}),`${kind==='carry_forward'?'Released unpaid balance':'Non-cash balancing entry'} for ${e.id}. ${reason}. This is not a refund or recovered money.`,isCarry?'pending':'paid',isCarry?null:date,isCarry?null:p.id,isCarry&&amount<0n?'outstanding_offset':'balance_reclassification',e.campaign_id,e.opportunity_id]);
      if(!isCarry)await db.query('INSERT INTO payout_batch_entries(payout_batch_id,commission_entry_id,tenant_id) VALUES($1,$2,$3)',[p.id,earningId,u.tenantId]);
    }
  }
  await db.query("UPDATE payout_batches SET status='partially_paid',reconciliation_status='partial_closed',released_amount_minor=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[u.tenantId,p.id,remaining.toString()]);
  await audit(db,u,'payout',p.id,'partial_closed',{approvedMinor:total.toString(),confirmedCashMinor:paid.toString(),releasedMinor:remaining.toString(),reason,date});return{id:p.id,paidMinor:paid.toString(),releasedMinor:remaining.toString()};
}
