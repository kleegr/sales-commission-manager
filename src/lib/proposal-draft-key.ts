/** New proposals get independent recovery slots; document edits use their own id. */
export function newProposalDraftKey(): string {
  return `new:${crypto.randomUUID()}`;
}

export function isNewProposalDraftKey(key: string): boolean {
  return key === 'new' || /^new:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
}
