// Which server id each new chat's temp id became. The chat store records it
// when a create returns (`hydrateLocalConversation`), before the URL moves.

const promoted = new Map<string, string>();
const MAX_ENTRIES = 50;

export function aeRecordTempPromotion(tempId: string, realId: string): void {
  promoted.delete(tempId);
  promoted.set(tempId, realId);
  if (promoted.size > MAX_ENTRIES) promoted.delete(promoted.keys().next().value as string);
}

/** The server id *tempId* became, if it has. */
export function aeTempPromotedTo(tempId: string): string | undefined {
  return promoted.get(tempId);
}
