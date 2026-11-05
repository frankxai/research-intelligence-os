// Research registry: privacy. Unicode normalisation, the hashed name list and redaction for the private tier, and the
// exclusion test that withholds a document from both tiers.

import { createHash } from 'node:crypto';
import { DEFAULT_PERSONAL_PATTERNS, classifyKind, normalizeEol } from './lib.mjs';

// ---------------------------------------------------------------------------------------------
// Private-tier name redaction (best effort; defence in depth behind the shareable tier). Every private string is
// passed through the redactor, and every private output is scanned again before anything is written. Names are
// listed as SHA-256 hashes of the normalized phrase, so the list itself names no one; hashes of short names are
// guessable, so the list stays private. exclude.txt patterns redact too.
//
// Matching text is normalized one code point at a time, keeping a map back to the original so a match is redacted
// in place: NFKC maps full-width, circled and ligature forms to plain letters; every format character (\p{Cf}:
// zero-width, bidi controls, soft hyphen) is dropped; NFD then drops every nonspacing mark (\p{Mn}: accents,
// variation selectors); case is folded lower-upper-lower, so "ß", "ẞ" and "SS" agree. NOT caught: look-alike
// letters from another script (a Cyrillic "а" for a Latin "a") and a name glued to the next word by an invisible
// character. A denylist cannot be complete, which is why only the shareable tier is meant for others.
const CF_RE = /\p{Cf}/gu;
const MN_RE = /\p{Mn}/gu;
const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;
const foldCase = (s) => s.toLowerCase().toUpperCase().toLowerCase();
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function foldCodePoint(cp) {
  if (cp.charCodeAt(0) < 0x80) return cp.toLowerCase();
  const plain = cp.normalize('NFKC').replace(CF_RE, '').normalize('NFD').replace(MN_RE, '');
  return foldCase(plain).normalize('NFD').replace(MN_RE, '');
}

function tokens(text) {
  const s = String(text ?? '');
  let norm = '';
  const from = [];
  const to = [];
  let i = 0;
  for (const cp of s) {
    const f = foldCodePoint(cp);
    for (let k = 0; k < f.length; k += 1) { from.push(i); to.push(i + cp.length); }
    norm += f;
    i += cp.length;
  }
  return [...norm.matchAll(WORD_RE)].map((m) => ({ start: from[m.index], end: to[m.index + m[0].length - 1], w: m[0] }));
}

export function phraseOf(text) {
  return tokens(text).map((t) => t.w).join(' ');
}

export const phraseHash = (phrase) => sha256(phraseOf(phrase));

// A denylist entry records its word count, so the redactor searches exactly the phrase lengths it needs:
// any length is supported, and an entry whose length is unknown is refused instead of silently skipped.
export function redactEntry(phrase) {
  const words = tokens(phrase).length;
  if (!words) throw new Error('a redaction phrase needs at least one letter or digit');
  return { hash: phraseHash(phrase), words };
}

const ENTRY_RE = /^([0-9a-f]{64})\s+(\d+)(?:\s+#.*)?$/;

// `<sha256> <word count>  # label` per line; blank lines and # comments are skipped. Any other line, and any word
// count that is not a positive safe integer, stops the build: such an entry would otherwise never match.
export function parseRedactList(text) {
  return normalizeEol(text).split('\n').map((l, i) => [l.trim(), i + 1]).filter(([l]) => l && !l.startsWith('#')).map(([l, n]) => {
    const m = l.match(ENTRY_RE);
    const words = m ? Number(m[2]) : NaN;
    if (!Number.isSafeInteger(words) || words < 1) {
      throw new Error(`redaction list line ${n} is not "<sha256> <word count>  # label" with a positive whole word count: regenerate it with "node registry.mjs redact-hash"`);
    }
    return { hash: m[1], words };
  });
}

function mergeSpans(spans) {
  const out = [];
  for (const s of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push([...s]);
  }
  return out;
}

// A match also takes the format characters touching it, so no orphaned bidi or zero-width control is left behind.
const FORMAT_CHAR_RE = /\p{Cf}/u;
function widen(text, [a, b]) {
  let start = a;
  let end = b;
  while (start > 0 && FORMAT_CHAR_RE.test(text[start - 1])) start -= 1;
  while (end < text.length && FORMAT_CHAR_RE.test(text[end])) end += 1;
  return [start, end];
}

// redact(text, mask) -> { text, hits }: hits holds 'denylist' and/or 'exclusion' for what matched.
// entries: [{ hash, words }] from parseRedactList or redactEntry; phrases: plain exclusion patterns.
export function makeRedactor({ entries = [], phrases = [] } = {}) {
  const hashSet = new Set(entries.map((e) => e.hash));
  const phraseSet = new Set(phrases.map(phraseOf).filter(Boolean));
  const lengths = [...new Set([...entries.map((e) => e.words), ...[...phraseSet].map((p) => p.split(' ').length)])].sort((a, b) => a - b);
  const kindOf = (p) => (phraseSet.has(p) ? 'exclusion' : hashSet.has(sha256(p)) ? 'denylist' : null);
  return (value, mask = '[redacted]') => {
    const text = String(value);
    const words = tokens(text);
    const spans = [];
    const hits = new Set();
    for (let i = 0; i < words.length; i += 1) {
      for (const n of lengths) {
        if (i + n > words.length) break;
        const kind = kindOf(words.slice(i, i + n).map((x) => x.w).join(' '));
        if (kind) { hits.add(kind); spans.push([words[i].start, words[i + n - 1].end]); }
      }
    }
    let out = text;
    for (const [a, b] of mergeSpans(spans.map((s) => widen(text, s))).reverse()) out = `${out.slice(0, a)}${mask}${out.slice(b)}`;
    return { text: out, hits };
  };
}

// Keys and paths keep a slug shape; free text gets a visible marker.
const SLUG_FIELDS = new Set(['key', 'local_path']);

export function redactRow(row, redact) {
  const hits = new Set();
  const clean = (v, field) => {
    const r = redact(v, SLUG_FIELDS.has(field) ? 'redacted' : '[redacted]');
    r.hits.forEach((h) => hits.add(h));
    return r.text;
  };
  const out = Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
    typeof v === 'string' ? clean(v, k) : Array.isArray(v) ? v.map((x) => clean(x, k)) : v]));
  return { row: out, hits };
}

// ---------------------------------------------------------------------------------------------
// Exclusion.

// The pipeline's own exclusion test (lib.mjs classifyKind): a title containing a personal pattern (the defaults
// plus exclude.txt, as a case-insensitive substring) is 'personal'; one matching SENSITIVE_RE is 'sensitive'.
export function pipelineExcludes(title, personalPatterns = DEFAULT_PERSONAL_PATTERNS) {
  return ['personal', 'sensitive'].includes(classifyKind({ title: String(title ?? '') }, personalPatterns));
}

// Excluded: a listed Drive id, a quarantined key, the pipeline's own test, or (stricter than the pipeline) an
// exclusion pattern matching whole words once separators, case and Unicode forms are normalized.
export function isExcluded({ key, f }, { quarantineKeys, personalPatterns, redact }) {
  return f.excludedId || quarantineKeys.has(key) || pipelineExcludes(f.title, personalPatterns)
    || redact(`${f.title}\n${key}`).hits.has('exclusion');
}

