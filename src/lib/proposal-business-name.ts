/** Resolve known business-name placeholders without interpreting arbitrary client text. */
export function resolveBusinessName(text: string, businessName?: string | null): string {
  const name = businessName?.trim() || 'our company';
  return text.replace(/\[\s*(?:(?:your|our)\s+)?(?:business|company)[ _]+name\s*\]|\{\{\s*(?:business|company)_name\s*\}\}/gi, () => name);
}
