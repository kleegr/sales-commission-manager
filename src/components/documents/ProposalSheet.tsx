import {billableQty} from '../../lib/proposal-suite';
import { Check, MessageSquareText } from 'lucide-react';
import type { DocumentLineItem, DocumentSection } from '../../types';
import type { PreviewBranding } from './DocumentPreview';
import { SECTION_LABELS } from '../../lib/documents';
import { proposalTotals } from '../../lib/proposal-pricing';
import { displayMinor } from '../../lib/exact-commission';
import { resolveBusinessName } from '../../lib/proposal-business-name';

interface Props {
  title: string;
  sections: DocumentSection[];
  branding: PreviewBranding;
  items?: DocumentLineItem[];
  currency: string;
  digits?: number;
  recipient?: { name: string; company: string } | null;
  preparedBy?: string;
  sentAt?: string | null;
  expiresAt?: string | null;
}
const date = (value: string) => new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const periodName = (period: string) => ({ month: 'Monthly', year: 'Annual', week: 'Weekly', day: 'Daily' }[period] || `Every ${period}`);
const paragraphs = (text: string) => text.split(/\n{2,}/).filter(Boolean).map((part, i) => <p key={i}>{part}</p>);

/** The same catalog-backed document is used by the private preview and public link. */
export function ProposalSheet({ title, sections, branding, items = [], currency, digits = 2, recipient, preparedBy, sentAt, expiresAt }: Props) {
  const totals = proposalTotals(items);
  const money = (value: bigint) => displayMinor(value.toString(), currency, digits);
  const content = sections.map(section => ({...section, content:resolveBusinessName(section.content, branding.businessName)})).filter(section => section.content.trim());
  const summary = content.find(section => /summary/i.test(section.title)) || content.find(section => section.type === 'solution');
  const terms = content.filter(section => ['terms', 'payment_terms', 'cancellation', 'refund', 'term_length', 'disclaimers'].includes(section.type));
  const remaining = content.filter(section => section !== summary && !terms.includes(section));
  const groups = [...Object.keys(totals.recurring).map(period => ({
    label: `${periodName(period)} breakdown`, totalLabel: `${periodName(period)} total`, period,
    items: items.filter(item => item.billingKind === 'recurring' && (item.recurringInterval || 'month') === period), total: totals.recurring[period],
  })), ...(items.some(item => item.billingKind !== 'recurring') ? [{
    label: 'One-time & setup breakdown', totalLabel: 'One-time total', period: '',
    items: items.filter(item => item.billingKind !== 'recurring'), total: totals.oneTime,
  }] : [])];
  const brand = <>{branding.logoUrl ? <img src={branding.logoUrl} alt={branding.businessName || 'Company logo'} /> : <strong className="proposal-wordmark">{branding.businessName || 'Proposal'}</strong>}</>;
  return <article className="proposal-sheet" aria-label="Proposal document">
    <div className="proposal-sheet-body">
      <header className="proposal-sheet-header">
        <div><div className="proposal-sheet-logo">{brand}</div><span className="proposal-sheet-eyebrow">{recipient ? 'Prepared for' : 'Proposal'}</span><h1>{recipient?.company || recipient?.name || title}</h1>{recipient?.company && recipient.name && <p>{recipient.name}</p>}{recipient && <p className="proposal-sheet-subtitle">{title}</p>}</div>
        <div className="proposal-sheet-preparer"><strong>Prepared by {preparedBy || branding.businessName || 'your team'}</strong>{sentAt && <span>Date: {date(sentAt)}</span>}{expiresAt && <span>Valid until {date(expiresAt)}</span>}</div>
      </header>
      {summary && <section className="proposal-summary-callout"><h2><MessageSquareText size={16} />{summary.title || 'Proposal summary'}</h2>{paragraphs(summary.content)}</section>}
      {!!items.length && <>
        <section className="proposal-sheet-section" aria-label="Proposed investment"><h2>Proposed investment</h2><div className="proposal-investment-cards">
          {Object.entries(totals.recurring).map(([period, total]) => <div className="proposal-investment-card is-recurring" key={period}><span>{periodName(period)} investment</span><strong>{money(total)}<small>/{period}</small></strong><p>{items.filter(item => item.billingKind === 'recurring' && (item.recurringInterval || 'month') === period).length} recurring product{items.filter(item => item.billingKind === 'recurring' && (item.recurringInterval || 'month') === period).length === 1 ? '' : 's'}</p></div>)}
          <div className="proposal-investment-card"><span>One-time & setup</span><strong>{money(totals.oneTime)}</strong><p>{totals.oneTime === 0n ? 'No one-time charges' : 'Initial services and setup'}</p></div>
        </div></section>
        <section className="proposal-sheet-section"><h2>Included in your proposal</h2><ul className="proposal-inclusions">{items.map((item, i) => <li key={`${item.productId}-${i}`}><Check size={15}/><div><strong>{item.qty} × {item.name}</strong>{item.description && <p>{item.description}</p>}</div></li>)}</ul></section>
      </>}
      {remaining.map(section => <section className="proposal-sheet-section" key={section.id}><h2>{section.title || SECTION_LABELS[section.type]}</h2>{paragraphs(section.content)}</section>)}
      {groups.map(group => <section className="proposal-sheet-section" key={group.period}><h2>{group.label}</h2><div className="proposal-breakdown"><table><caption className="sr-only">{group.label}</caption><thead><tr><th scope="col">Product / service</th><th scope="col">Amount</th></tr></thead><tbody>{group.items.map((item, i) => <tr key={`${item.productId}-${i}`}><td><strong>{item.name}</strong><small>{billableQty(item)} × {displayMinor(item.unitPriceMinor, currency, digits)}</small></td><td>{money(BigInt(item.unitPriceMinor) * BigInt(billableQty(item)))}{group.period && <small>/{group.period}</small>}</td></tr>)}</tbody><tfoot><tr><th scope="row">{group.totalLabel}</th><td>{money(group.total)}{group.period && <small>/{group.period}</small>}</td></tr></tfoot></table></div></section>)}
      {terms.map(section => <section className="proposal-terms-card" key={section.id}><h2>{section.title || SECTION_LABELS[section.type]}</h2>{paragraphs(section.content)}</section>)}
      {!!items.length && <div className="proposal-payment-note"><strong>First payment: {money(totals.firstPayment)}</strong><span>Includes one billing period of each recurring product plus one-time charges. Approval and payment are separate steps.</span></div>}
      <div className="proposal-document-meta"><span>{branding.businessName || 'Proposal'}</span>{sentAt && <span>Issued {date(sentAt)}</span>}{expiresAt && <span>Valid until {date(expiresAt)}</span>}</div>
    </div>
    <footer className="proposal-sheet-footer"><div className="proposal-sheet-logo">{brand}</div><div>{[branding.website, branding.contactEmail, branding.contactPhone].filter(Boolean).map((detail, i) => <span key={i}>{detail}</span>)}{branding.companyAddress && <span>{branding.companyAddress}</span>}</div></footer>
  </article>;
}
