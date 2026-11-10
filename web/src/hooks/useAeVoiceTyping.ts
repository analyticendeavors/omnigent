// "Type instead" on the Voice sheet: the text box shows for one message. It hides
// again once the chat gets busy (the message was sent) or Voice mode turns off.

import { useCallback, useEffect, useState } from "react";

export function useAeVoiceTyping(
  voiceOn: boolean,
  busy: boolean,
): { typing: boolean; startTyping: () => void } {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (busy || !voiceOn) setTyping(false);
  }, [busy, voiceOn]);
  const startTyping = useCallback(() => setTyping(true), []);
  return { typing, startTyping };
}
