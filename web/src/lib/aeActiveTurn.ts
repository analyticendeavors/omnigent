// True when a scroll container is within `slackPx` of its real end. scrollHeight
// includes the spacer below the last turn, so this matches StickToBottom's view
// of "at the bottom".
export function aeAtTranscriptEnd(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  slackPx = 4,
): boolean {
  return scrollHeight - clientHeight - scrollTop <= slackPx;
}
