// An iPhone can hand the composer a copied note as a percent-encoded URL: text
// that opens with `Word: ` parses as a URL with a scheme, so the clipboard comes
// back lowercased with every space and newline as %20 and %0A
// ("THREAD: a\nNEXT: b" arrives as "thread:%20a%0ANEXT:%20b"). Real URLs never
// carry an encoded space right after the scheme colon, so that shape is safe to
// undo.
//
// Measured on an iPhone (iOS 18.7, 2026-10-27): the clipboard carries both
// `text/plain` (the exact note, capitals and all) and `text/uri-list` (the
// encoded copy), and the browser's own paste inserts the encoded one. So the
// repair prefers `text/plain` whenever the URI form is the encoded note; the
// encoded text is decoded only when it is all the clipboard offers, and then
// the scheme's case is lost for good.

const ENCODED_NOTE = /^[a-z][a-z0-9+.-]*:(?:%20|%0A)\S*$/;
// A note has many words; a custom URL with one escaped space (obsidian:%20Note)
// is left alone.
const ESCAPED_BREAK = /%20|%0A/g;

function isEncodedNote(text: string): boolean {
  return ENCODED_NOTE.test(text) && (text.match(ESCAPED_BREAK)?.length ?? 0) >= 3;
}

/** True when `plain` is `uri` decoded, ignoring case (the URL form lowercases the scheme). */
function decodesTo(uri: string, plain: string): boolean {
  try {
    // A copied block ends in a newline: the URL form keeps it as a trailing %0A
    // while the caller trimmed `plain`, so both sides are trimmed here.
    return decodeURIComponent(uri).trim().toLowerCase() === plain.trim().toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The text to insert in place of what the browser would paste, or null to let
 * it paste. `plain` and `uriList` are the clipboard's `text/plain` and
 * `text/uri-list`; the note is repaired when either one is the encoded form.
 */
export function repairEncodedNote(plain: string, uriList = ""): string | null {
  const uri = uriList.trim();
  const text = plain.trim();
  // The exact note beside its encoded URI copy: insert the exact note.
  if (isEncodedNote(uri) && text !== "" && !isEncodedNote(text) && decodesTo(uri, text)) {
    return plain;
  }
  if (!isEncodedNote(text)) return null;
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}
