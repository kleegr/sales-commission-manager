import type { DocumentLineItem } from '../types/index.js';
/** Integer money throughout; never combine different billing periods into MRR. */
export function proposalTotals(items: DocumentLineItem[]) {
  let oneTime = 0n;
  const recurring: Record<string, bigint> = {};
  for (const item of items) {
    if (!Number.isSafeInteger(item.qty) || item.qty < 1 || !/^\d+$/.test(item.unitPriceMinor)) continue;
    const amount = BigInt(item.qty) * BigInt(item.unitPriceMinor);
    if (item.billingKind === 'recurring') {
      const period = item.recurringInterval || 'month';
      recurring[period] = (recurring[period] || 0n) + amount;
    } else oneTime += amount;
  }
  return { oneTime, recurring, firstPayment: Object.values(recurring).reduce((sum, amount) => sum + amount, oneTime) };
}
export const billingLabel = (item: Pick<DocumentLineItem, 'billingKind' | 'recurringInterval'>) =>
  item.billingKind === 'recurring' ? `Every ${item.recurringInterval || 'month'}` : item.billingKind === 'setup' ? 'Setup fee' : 'One-time';
