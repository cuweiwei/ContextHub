// Text utilities for CJK-aware full-text search.
//
// FTS5's unicode61 tokenizer treats a run of CJK characters as a single token,
// so a query for 財務 would not match an item containing 財務規劃. The trigram
// tokenizer handles CJK but cannot match 2-character terms, which are extremely
// common in Chinese. Instead we segment CJK text character-by-character (spaces
// injected) on BOTH the index side and the query side, and issue phrase
// queries, so any-length Chinese substrings match while English keeps normal
// word tokenization.

// Hiragana/Katakana (U+3040-30FF), CJK Ext A (U+3400-4DBF),
// CJK Unified (U+4E00-9FFF), CJK Compatibility Ideographs (U+F900-FAFF).
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

export function isCjkChar(ch: string): boolean {
  return CJK_RE.test(ch);
}

/** `財務規劃app` → `財 務 規 劃 app` */
export function segmentCjk(text: string): string {
  let out = '';
  for (const ch of text) {
    out += isCjkChar(ch) ? ` ${ch} ` : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Builds an FTS5 MATCH expression from a user query. Each whitespace-separated
 * token becomes a quoted phrase (CJK-segmented so adjacency is preserved);
 * tokens are ANDed. Returns null when nothing searchable remains.
 */
export function buildFtsQuery(raw: string): string | null {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const phrases: string[] = [];
  for (const token of tokens) {
    const seg = segmentCjk(token).replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
    if (seg) phrases.push(`"${seg}"`);
  }
  if (phrases.length === 0) return null;
  return phrases.join(' AND ');
}

/**
 * Token-efficient snippet for agent-facing search results: a window around the
 * first query-token hit in `content`, or the head of the content when the hit
 * was in the title/tags. Generated in JS from the original (unsegmented) text
 * so Chinese renders without injected spaces.
 */
export function makeSnippet(content: string, queryTokens: string[], maxLen = 160): string {
  const clean = content.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const lower = clean.toLowerCase();
  let hit = -1;
  for (const token of queryTokens) {
    const t = token.toLowerCase();
    if (!t) continue;
    const idx = lower.indexOf(t);
    if (idx !== -1 && (hit === -1 || idx < hit)) hit = idx;
  }
  if (hit === -1) return clean.slice(0, maxLen) + '…';
  const start = Math.max(0, hit - Math.floor(maxLen / 3));
  const end = Math.min(clean.length, start + maxLen);
  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '');
}
