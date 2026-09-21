import type {SQL} from './tracker-common.js';

/** A proposal checkout is one charge, even when products post separate receipts. */
export async function nextPaymentCharge(db:SQL,tenantId:string,clientId:string,proposalId?:string){
  return Number((await db.query(`SELECT count(DISTINCT COALESCE('proposal:'||d.id,p.id))::text AS n
    FROM payments p LEFT JOIN documents d ON d.tenant_id=p.tenant_id AND COALESCE(d.client_id,d.created_client_id)=p.client_id
      AND (p.event_key='proposal:'||d.id OR left(p.event_key,length('proposal:'||d.id||':'))='proposal:'||d.id||':')
    WHERE p.tenant_id=$1 AND p.client_id=$2 AND p.receipt_status='confirmed' AND p.parent_payment_id IS NULL
      AND ($3::text IS NULL OR d.id IS DISTINCT FROM $3)`,[tenantId,clientId,proposalId||null])).rows[0].n)+1;
}
