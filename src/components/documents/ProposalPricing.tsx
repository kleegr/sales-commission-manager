import type { DocumentLineItem } from '../../types';
import { displayMinor } from '../../lib/exact-commission';
import { billingLabel, proposalTotals } from '../../lib/proposal-pricing';
export function ProposalPricing({items, currency, digits = 2, detailed = true}: {items: DocumentLineItem[]; currency: string; digits?: number; detailed?: boolean}) {
  const totals = proposalTotals(items);
  const money = (amount: bigint) => displayMinor(amount.toString(), currency, digits);
  return <section className="proposal-pricing" aria-label="Proposal pricing">
    <h3>Your investment</h3>
    {detailed && <div className="proposal-items">{items.map((item, index) => <div key={`${item.productId}-${index}`} className="proposal-item">
      <div><strong>{item.name}</strong>{item.description && <p>{item.description}</p>}<small>{item.qty} × {displayMinor(item.unitPriceMinor, currency, digits)} · {billingLabel(item)}</small></div>
      <b>{money(proposalTotals([item]).firstPayment)}</b>
    </div>)}</div>}
    <dl><div><dt>One-time & setup</dt><dd>{money(totals.oneTime)}</dd></div>
      {Object.entries(totals.recurring).map(([period, amount]) => <div key={period}><dt>Every {period}</dt><dd>{money(amount)}</dd></div>)}
      <div className="proposal-total"><dt>First payment</dt><dd>{money(totals.firstPayment)}</dd></div>
    </dl>
    <p className="proposal-caption">First payment includes one billing period of each recurring item. Future billing follows the intervals above. Approval records agreement; payment is tracked separately.</p>
  </section>;
}
