// Turns a markdown reply into text a speech engine can read aloud, and cuts a
// streaming reply at safe sentence boundaries. Pure functions, no DOM.

export const CODE_BLOCK_PHRASE = "Code block skipped.";

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const SENTENCE_CLOSERS = "\"')]*_";

/** Replaces each fenced code block (closed or not) with one spoken phrase. */
function replaceFences(markdown: string): string {
  const out: string[] = [];
  let marker: string | null = null;
  for (const line of markdown.split("\n")) {
    const fence = FENCE_RE.exec(line);
    if (marker === null) {
      if (fence) {
        marker = fence[1][0];
        out.push(CODE_BLOCK_PHRASE);
      } else {
        out.push(line);
      }
    } else if (fence && fence[1][0] === marker && line.trim().replace(/[`~]/g, "") === "") {
      marker = null;
    }
  }
  return out.join("\n");
}

function stripEmphasis(line: string): string {
  return line
    .replace(/(?<![\w*])\*\*(?=[^\s*])(.+?)(?<=[^\s*])\*\*(?![\w])/g, "$1")
    .replace(/(?<![\w])__(?=\S)(.+?)(?<=\S)__(?![\w])/g, "$1")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=\S)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w])/g, "$1");
}

/** Markdown reply to plain sentences for the voice. */
export function speechTextFromMarkdown(markdown: string): string {
  let text = replaceFences(markdown.replace(/\r\n?/g, "\n"));
  text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/<\/?[a-zA-Z][^>\n]*>/g, "");
  text = text
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/https?:\/\/[^\s)]+/g, "link");

  const spoken: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (line === "") continue;
    if (/^([-*_])(\s*\1){2,}$/.test(line)) continue;
    if (/^\[[^\]]+\]:\s/.test(line)) continue;
    if (line.includes("|") && /^[\s|:-]+$/.test(line) && line.includes("-")) continue;
    line = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(>\s?)+/, "")
      .replace(/^[-*+]\s+/, "");
    if (line.startsWith("|") || line.endsWith("|")) {
      line = line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter((cell) => cell !== "")
        .join(", ");
    } else {
      line = line.replace(/\s+\|\s+/g, ", ");
    }
    line = stripEmphasis(line.replace(/`([^`\n]*)`/g, "$1")).trim();
    if (line === "") continue;
    spoken.push(/[.!?:;]$/.test(line) ? line : `${line}.`);
  }
  return spoken.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Drops the TLDR recap at the end of a reply. A reply that is only a TLDR is
 * returned unchanged so it is still spoken.
 */
export function stripTldr(markdown: string): string {
  const lines = markdown.split("\n");
  const at = lines.findIndex((line) => /^(tldr|tl;dr):?$/i.test(line.replace(/[*_~#>\s]/g, "")));
  if (at < 0) return markdown;
  const before = lines.slice(0, at).join("\n");
  return before.trim() === "" ? markdown : before.trimEnd();
}

/**
 * Longest prefix of a streaming reply that ends at a sentence boundary, never
 * inside a code fence, an open link or a number such as 3.5.
 */
export function completeSentences(markdown: string): { ready: string; rest: string } {
  const text = markdown;
  let boundary = 0;
  let inFence: string | null = null;
  let bracket = 0;
  let url = false;
  let lineStart = 0;
  let i = 0;
  while (i < text.length) {
    if (i === lineStart) {
      const end = text.indexOf("\n", i);
      const line = text.slice(i, end < 0 ? text.length : end);
      const fence = FENCE_RE.exec(line);
      if (inFence === null && fence) {
        inFence = fence[1][0];
        if (i > boundary) boundary = i;
      } else if (inFence !== null && fence && fence[1][0] === inFence && /^[\s`~]*$/.test(line)) {
        inFence = null;
        if (end >= 0) boundary = end + 1;
      }
      if (inFence !== null || fence) {
        if (end < 0) break;
        i = end + 1;
        lineStart = i;
        continue;
      }
    }
    const ch = text[i];
    if (ch === "\n") {
      let j = i;
      while (j < text.length && text[j] === "\n") j++;
      if (j - i >= 2) {
        bracket = 0;
        url = false;
        boundary = j;
      }
      i = j;
      lineStart = j;
      continue;
    }
    if (url) {
      if (ch === ")") url = false;
    } else if (ch === "[") {
      bracket++;
    } else if (ch === "]" && bracket > 0) {
      bracket--;
      if (bracket === 0 && text[i + 1] === "(") {
        url = true;
        i++;
      }
    } else if ((ch === "." || ch === "!" || ch === "?") && bracket === 0) {
      let j = i + 1;
      while (j < text.length && SENTENCE_CLOSERS.includes(text[j])) j++;
      const before = text.slice(lineStart, i);
      const isListMarker = ch === "." && /^\s*\d+$/.test(before);
      if (j < text.length && /\s/.test(text[j]) && !isListMarker) {
        boundary = j;
      }
    }
    i++;
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
}

/** Splits spoken text into trimmed sentences. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?]["')\]]*)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

/** Sentence key for repeat detection: case, spacing, end marks and quotes ignored. */
export function normalizeSentence(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^["'\u201c\u2018\s]+|["'\u201d\u2019\s]+$/g, "")
    .replace(/[.!?]+["'\u201d\u2019]*$/, "")
    .trim();
}

/** Sentence-sized chunks, because Chrome stops an utterance past about 15 seconds. */
export function splitForSpeech(text: string, maxLen = 220): string[] {
  const sentences = splitSentences(text);
  const pieces: string[] = [];
  for (let sentence of sentences) {
    while (sentence.length > maxLen) {
      const head = sentence.slice(0, maxLen);
      let cut = Math.max(head.lastIndexOf(","), head.lastIndexOf(" "));
      if (cut <= 0) cut = maxLen - 1;
      pieces.push(sentence.slice(0, cut + 1).trim());
      sentence = sentence.slice(cut + 1).trim();
    }
    if (sentence !== "") pieces.push(sentence);
  }
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks.length - 1;
    if (last >= 0 && chunks[last].length + 1 + piece.length <= maxLen) {
      chunks[last] = `${chunks[last]} ${piece}`;
    } else {
      chunks.push(piece);
    }
  }
  return chunks.filter((c) => c !== "");
}
