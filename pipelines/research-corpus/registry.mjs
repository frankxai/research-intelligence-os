#!/usr/bin/env node
// Research registry: one transparent row per corpus report, a role relevance matrix and REGISTRY.md, in two tiers.
//
//   node registry.mjs build [--allow-unredacted]
//       corpus front matter + Gemini usage ledger + claim records -> RESEARCH_HOME/registry/
//         shareable/  reports.csv, reports.jsonl, roles.csv, REGISTRY.md: opaque ids and structural fields only
//         private/    the same files with titles, corpus keys, paths and Drive links: never share these
//   node registry.mjs redact-hash "<phrase>" [--label <label>]
//       prints the line to append to RESEARCH_HOME/registry/redact.sha256.txt
//
// Two tiers, because a name denylist can never be complete (look-alike letters from other scripts, new
// spellings, names nobody listed). The shareable tier carries no text from any report, file name, Drive id or
// ledger title: each report is an opaque id with enumerated, numeric and date fields, and before anything is
// written every shareable word must come from this file's own vocabulary and every character must be printable
// ASCII, or the build stops. The private tier keeps titles for the operator and is redacted best-effort.
// Documents excluded by Drive id, quarantine or a private exclusion pattern are withheld from both tiers; only
// their count is reported.
//
// Reads RESEARCH_HOME (corpus/, quarantine/, gemini-usage.jsonl, verify/, exclude.txt, exclude-ids.txt,
// domains.local.json, registry/weights.local.json, registry/redact.sha256.txt) and writes only
// RESEARCH_HOME/registry/. The release verdict is the claim gate's own (`corpus.mjs verify score`); the rank
// only orders review.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_PERSONAL_PATTERNS, classifyKind, evidenceStats, extractClaims, normalizeEol, scoreClaims, usagePlan,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------------------------
// Weights. Hypotheses, not calibrated values: they order the review queue and never release a report.
export const WEIGHTS = { evidenceIntegrity: 40, sourceBreadth: 15, freshness: 15, verificationCoverage: 15, economicRelevance: 15 };
// Full sample-size credit once this many claims are checked (or every claim, for a shorter report).
const SAMPLE_FOR_FULL_CREDIT = 10;
// Full breadth credit at this many distinct cited hosts; linear below it.
const HOSTS_FOR_FULL_CREDIT = 25;
// Full freshness inside the domain's refresh window (staleDays), then linear to zero over this many more windows.
const FRESHNESS_DECAY_WINDOWS = 2;
const DEFAULT_STALE_DAYS = 30;

// Economic relevance comes only from this table (0-1 per domain), never from keywords. Private domain ids
// and any overrides live in RESEARCH_HOME/registry/weights.local.json, never in this public file.
export const ECONOMIC_DOMAIN_WEIGHTS = {
  'agentic-income-streams': 1, 'business-strategy': 0.8, 'digital-product-design': 0.7, marketing: 0.6,
  'ai-models-platforms': 0.5, 'web-design': 0.4, community: 0.4, 'github-ecosystem': 0.3, 'publishing-books': 0.3,
  'music-media': 0.3, 'web3-general': 0.2, solana: 0.2, ethereum: 0.2, bitcoin: 0.2, 'human-potential': 0.1, unrouted: 0,
};

// Topical relevance 0-3 per role: the report's domain gives 0-2 ('*' is the default for any domain), a keyword in
// the title adds 1, and two or more distinct keywords in the headings add 1. A keyword ending in '*' matches as a
// word prefix, any other as whole words. Relevance says what a report is about, never whether it is true.
export const ROLES = {
  'product-strategist': {
    domains: { 'business-strategy': 2, 'digital-product-design': 2, 'agentic-income-streams': 1, 'ai-models-platforms': 1, 'web-design': 1 },
    keywords: ['product*', 'strateg*', 'roadmap*', 'persona*', 'market', 'markets', 'offer*', 'decision*', 'launch*', 'opportunit*', 'wedge'],
  },
  'pricing-and-monetization': {
    domains: { 'agentic-income-streams': 2, 'business-strategy': 1, 'digital-product-design': 1 },
    keywords: ['pric*', 'monetiz*', 'revenue', 'checkout', 'subscription*', 'merchant of record', 'economics', 'margin*', 'affiliate*', 'income', 'refund*', 'whop', 'gumroad', 'polar'],
  },
  'growth-and-distribution': {
    domains: { marketing: 2, community: 1, 'agentic-income-streams': 1, 'web-design': 1 },
    keywords: ['seo', 'aeo', 'geo', 'growth', 'distribution', 'funnel*', 'launch*', 'audience*', 'newsletter*', 'social', 'channel*', 'campaign*', 'outreach'],
  },
  'legal-and-compliance': {
    domains: { 'business-strategy': 1 },
    keywords: ['legal', 'complian*', 'gdpr', 'ai act', 'licens*', 'agreement*', 'contract*', 'ip', 'terms', 'privacy', 'joint venture', 'regulat*', 'liabilit*', 'consent'],
  },
  'platform-engineer': {
    domains: { 'ai-models-platforms': 2, 'github-ecosystem': 2, 'web-design': 2, 'digital-product-design': 1 },
    keywords: ['architecture', 'cloudflare', 'vercel', 'next js', 'supabase', 'mcp', 'runtime*', 'ci', 'cms', 'schema*', 'api', 'sdk', 'harness', 'multi agent', 'orchestrat*', 'protocol', 'cli', 'infrastructure', 'deploy*'],
  },
  'brand-and-voice': {
    domains: { marketing: 2, 'business-strategy': 1, 'publishing-books': 1 },
    keywords: ['brand*', 'voice', 'narrative*', 'positioning', 'culture', 'identity', 'story', 'stories', 'editorial', 'style', 'tone', 'messaging'],
  },
  'creator-media': {
    domains: { 'music-media': 2, 'publishing-books': 2, marketing: 1 },
    keywords: ['creator*', 'media', 'music', 'video*', 'podcast*', 'book*', 'chapter*', 'sonic', 'lyric*', 'content', 'studio', 'script*', 'recording'],
  },
  'investor-analyst': {
    domains: { 'business-strategy': 2, 'agentic-income-streams': 1, 'web3-general': 1, solana: 1, ethereum: 1, bitcoin: 1 },
    keywords: ['investor*', 'funding', 'market size', 'economics', 'portfolio', 'allocation', 'moat', 'valuation', 'accelerator*', 'startup*', 'financ*', 'capital'],
  },
  'support-agent': {
    domains: { community: 1 },
    keywords: ['support', 'faq*', 'help', 'onboarding', 'guide*', 'runbook*', 'readme', 'troubleshoot*', 'customer*', 'sop*', 'handbook*', 'manual*', 'checklist*'],
  },
  'research-analyst': {
    domains: { '*': 1 },
    keywords: ['research*', 'evidence', 'audit*', 'verif*', 'sources', 'dossier*', 'analysis', 'science', 'epistemic', 'report*', 'benchmark*', 'archaeology'],
  },
};

// ---------------------------------------------------------------------------------------------
// Columns. The private tier adds titles, keys, paths, Drive links, checker names and block reasons; the shareable
// tier has only the opaque id and fields that are enumerated, numeric or dates.
export const SHARE_COLUMNS = [
  'row_id', 'domain', 'kind', 'source', 'created', 'age_days', 'producer', 'producer_mode', 'producer_model_recorded', 'producer_basis',
  'run_started', 'run_finished', 'ledger_run_status', 'ledger_domain', 'cost_basis', 'window_pct_cost', 'weekly_pct_cost',
  'source_urls', 'source_hosts', 'evidence', 'evidence_basis',
  'claims_in_report', 'claims_sampled', 'sampled_share', 'claims_checked', 'claims_verified', 'claims_partial', 'claims_contradicted',
  'claims_unsupported', 'claims_garbled', 'claims_unreachable', 'claims_pending', 'verified_rate', 'supported_rate',
  'release', 'release_block_count', 'checked_at', 'checker_recorded', 'claims_backup',
  'score_evidence_integrity', 'score_source_breadth', 'score_freshness', 'score_verification_coverage', 'score_economic_relevance', 'rank_score',
];
export const PRIVATE_COLUMNS = [
  'row_id', 'key', 'title', 'domain', 'kind', 'source', 'created', 'age_days',
  'producer', 'producer_mode', 'producer_model', 'producer_basis',
  'run_started', 'run_finished', 'ledger_run_status', 'ledger_domain', 'cost_basis', 'window_pct_cost', 'weekly_pct_cost',
  'drive_doc_id', 'drive_doc_url', 'local_path', 'source_urls', 'source_hosts', 'evidence', 'evidence_basis',
  'claims_in_report', 'claims_sampled', 'sampled_share', 'claims_checked', 'claims_verified', 'claims_partial', 'claims_contradicted',
  'claims_unsupported', 'claims_garbled', 'claims_unreachable', 'claims_pending', 'verified_rate', 'supported_rate',
  'release', 'release_block_count', 'release_blocks', 'checker', 'checked_at', 'claims_backup', 'privacy',
  'score_evidence_integrity', 'score_source_breadth', 'score_freshness', 'score_verification_coverage', 'score_economic_relevance', 'rank_score',
];
export const SHARE_ROLE_COLUMNS = ['row_id', 'domain', 'kind', 'evidence', 'release', ...Object.keys(ROLES), 'human_reader', 'agent_reader'];
export const PRIVATE_ROLE_COLUMNS = ['row_id', 'key', 'title', 'domain', 'kind', 'evidence', 'release', ...Object.keys(ROLES), 'human_reader', 'agent_reader'];

// The public schema of the shareable tier, defined here and nowhere else: private configuration (domains.local.json,
// weights.local.json) can never add a word to it. Domain ids mirror the public domains.json (a test keeps the two
// in step); any other id, including every private one, is written as 'other'.
export const PUBLIC_DOMAIN_IDS = Object.freeze([
  'agentic-income-streams', 'ai-models-platforms', 'github-ecosystem', 'digital-product-design', 'web-design', 'marketing',
  'community', 'solana', 'ethereum', 'bitcoin', 'web3-general', 'publishing-books', 'music-media', 'human-potential',
  'business-strategy', 'unrouted',
]);
const PUBLIC_DOMAINS = new Set(PUBLIC_DOMAIN_IDS.filter((d) => /^[a-z0-9-]+$/.test(d)));

// The values a shareable enumerated field may take; anything else is written as 'other'.
const OTHER = 'other';
const ENUMS = {
  kind: ['deep-research', 'gemini-canvas', 'estate-doc', 'platform-catalog', 'unknown'],
  source: ['google-drive', 'local-file', 'live-catalogs', 'unknown'],
  producer: ['gemini-deep-research', 'gemini-chat', 'unknown'],
  producer_mode: ['deep-research', 'unknown'],
  producer_basis: ['usage-ledger', 'front-matter-classifier', 'none'],
  ledger_run_status: ['done', 'abandoned', 'open'],
  cost_basis: ['no-ledger', 'no-ledger-run', 'measured', 'not-measured', 'ambiguous-repeated-title'],
  evidence: ['cited', 'uncited'],
  evidence_basis: ['front-matter', 'computed-by-registry'],
  release: ['pass', 'blocked', 'unsampled'],
  claims_backup: ['none', 'identical', 'differs', 'backup-only'],
};
const SHARE_NUMBERS = [
  'age_days', 'window_pct_cost', 'weekly_pct_cost', 'source_urls', 'source_hosts', 'claims_in_report', 'claims_sampled', 'sampled_share',
  'claims_checked', 'claims_verified', 'claims_partial', 'claims_contradicted', 'claims_unsupported', 'claims_garbled',
  'claims_unreachable', 'claims_pending', 'verified_rate', 'supported_rate', 'release_block_count',
  'score_evidence_integrity', 'score_source_breadth', 'score_freshness', 'score_verification_coverage', 'score_economic_relevance',
];
const SHARE_DATES = ['created', 'run_started', 'run_finished', 'checked_at'];

// How a person and an agent should consume a report, by what has been checked, not by topic. A pass covers
// only the sampled claims a checker supported; it says nothing about the rest of the report.
const READERS = {
  pass: ['Trust only the sampled claims marked verified or partial, as of their check date; the rest is unverified AI synthesis.', 'Use only verified and partial claim records, each with its source and date; treat everything else in the report as unverified.'],
  blocked: ['Read the blocked and contradicted claims first; use it for direction, not numbers.', 'Use only verified claim records; never repeat contradicted or unchecked claims.'],
  local: ['Estate document as of its recorded commit; check for a newer version.', 'Cite with path and commit; re-read the source when it may have changed.'],
  cited: ['Skim as unverified AI synthesis; check any number before acting on it.', 'Retrieve for orientation only; label every statement unverified-ai-synthesis.'],
  uncited: ['Background reading; it cites too few sources to check claim by claim.', 'Context only; never cite it as evidence.'],
  notes: ['Internal planning notes; read as opinion, not research.', 'Planning context only; do not retrieve it as evidence.'],
};

export function readers(row) {
  if (row.release === 'pass') return READERS.pass;
  if (row.release === 'blocked') return READERS.blocked;
  if (row.source === 'local-file') return READERS.local;
  if (row.evidence === 'cited') return READERS.cited;
  return row.kind === 'deep-research' ? READERS.uncited : READERS.notes;
}

// Every word REGISTRY.md may contain in either tier, beyond values, ids, numbers and dates. ASCII only.
const TEXT = {
  headPrivate: '# Research registry: PRIVATE tier',
  headShare: '# Research registry: shareable tier',
  notePrivate: '> **Private: do not share.** This tier holds titles, corpus keys, file paths and Drive links. Names are redacted against the private name list on a best-effort basis only: look-alike letters from another script, and a name glued to the next word by an invisible character, are not caught. Share `registry/shareable/` instead.',
  noteShare: '> **Shareable.** This tier holds no titles, file paths, corpus keys, Drive ids or links, and no text taken from a report or a ledger title. Each report is an opaque id (the first 12 hex digits of the SHA-256 of its corpus key) with enumerated, numeric and date fields only. Before writing, every character was checked to be printable ASCII and every word to be in the registry vocabulary; anything else stops the build.',
  hypotheses: '> **Weights are hypotheses.** The rank score only orders what to review next; it never releases a report. Release comes only from the claim gate (`node corpus.mjs verify score <key>`): `pass` or `blocked`. A pass covers only the sampled claims a checker supported, never the whole report. A report with no claim records is `unsampled`, and its rank is `unranked`.',
  built: 'Built {at} from {n} corpus reports; {w} excluded, withheld (excluded by Drive id, quarantine or the pipeline exclusion rules: no row, ledger run, cost or claim diagnostic in either tier). reports.csv and reports.jsonl hold every column of this tier; roles.csv holds the role relevance matrix; all three share `row_id`, a pseudonym keyed by a private salt.',
  aFew: 'a few',
  paths: 'Paths are relative to RESEARCH_HOME.',
  checkedPrivate: 'Name check: every private output was scanned against {d} hashed name phrase(s) and {p} private exclusion pattern(s) before writing; a hit stops the build. Matches show as [redacted].',
  uncheckedPrivate: '**Not checked for personal names:** built with --allow-unredacted and no redaction list.',
  checkedShare: 'Structure check: printable ASCII only, and no word outside the registry vocabulary.',
  hSummary: '## Summary', hWeights: '## Weights (hypotheses)', hRanked: '## Ranked: claim-sampled reports',
  hQueue: '## Next to sample: unsampled reports with cited evidence',
  queueNote: 'Ordered by the three sub-scores that need no claim checks (breadth, freshness, economic relevance). This is a sampling queue, not a rank.',
  hLedger: '## Gemini usage ledger', hProblems: '## Problems found', hRoles: '## Roles: reports at relevance 2 or more', hAll: '## All reports',
  none: '- None.', na: 'n/a', local: '(local)', withheld: 'withheld',
  noLedger: 'No usage ledger was found, so run timing and cost columns are blank.',
  measured: 'Measured runs: {n}. Mean cost per measured run: window {s}, weekly {w}. A run is measured only when it is the only run between the readings around it and no meter reset falls inside (rules: README, "Gemini usage").',
  econ: 'Economic domain weights: {list}. Unlisted domains weigh 0.',
  summary: {
    reports: 'Reports in this tier', kinds: 'Kind deep-research / gemini-canvas / other', cited: 'Evidence cited (at least 10 URLs and 5 hosts)',
    sampled: 'Claim-sampled', release: 'Release pass / blocked / unsampled', ledger: 'Usage-ledger runs / matched to a report / with a measured cost',
    withheld: 'Excluded, withheld (no row in either tier)', redacted: 'Titles with a redacted name (private tier only)',
  },
  head: {
    measure: 'Measure', count: 'Count', component: 'Component', max: 'Max', rule: 'Rule', rank: 'Rank', report: 'Report', domain: 'Domain',
    release: 'Release', vci: 'Verified / checked / in report', share: 'Sampled share', integrity: 'Integrity', breadth: 'Breadth',
    fresh: 'Fresh', coverage: 'Coverage', econ: 'Econ', blocks: 'Blocks', kind: 'Kind', hosts: 'Hosts', evidence: 'Evidence', role: 'Role',
    rel2: 'Relevance >= 2', rel3: 'Relevance 3', runTitle: 'Run title', ledgerDomain: 'Ledger domain', status: 'Status',
    started: 'Started', finished: 'Finished', matched: 'Matched report',
  },
  component: { integrity: 'Evidence integrity', breadth: 'Source breadth', freshness: 'Freshness', coverage: 'Verification coverage', economic: 'Economic relevance' },
  rule: {
    integrity: 'verified / checked * min(1, checked / min({s}, claims in report)); blank when unsampled. Claims in report = every claim in any extraction mode (table and cited prose)',
    breadth: 'min(1, distinct cited hosts / {h})',
    freshness: 'full inside the domain refresh window (staleDays, default {d}), then linear to 0 over {w} more windows',
    coverage: 'min(1, checked claims / claims in report across all extraction modes); blank when unsampled',
    economic: 'domain weight * max; the per-domain weights are configuration, never keywords',
  },
  econPrivateOnly: 'The per-domain economic weights are private configuration and are listed only in the private tier.',
};

const PROBLEMS = {
  noManifest: 'claims file(s) have no sampling manifest, so the gate blocks them until resampled with `verify sample <key> --force`',
  unreadable: 'claims file(s) could not be read; their reports are blocked',
  scoringFailed: 'report(s) could not be scored by the claim gate; they are blocked',
  domainDiffers: 'ledger-matched report(s) sit in a different corpus domain than the usage-ledger run recorded',
  notMeasured: 'ledger-matched report(s) have no measured cost: another run was open between the readings around it, or a meter reset fell inside',
  openRuns: 'usage-ledger run(s) are still open (no done or abandon record)',
  orphanCloses: 'usage-ledger done/abandon record(s) name a title that matches no run (a typo leaves the real run open)',
  unmatchedRuns: 'finished usage-ledger run(s) match no corpus report (not exported yet, or the title changed)',
  computedEvidence: 'report(s) lack evidence fields in front matter; the registry computed them from the body',
  withheld: 'excluded document(s) are still in the corpus (Drive id, quarantine or the pipeline exclusion rules); they are withheld from both tiers',
  backupDiffers: 'claims file(s) differ from their checked backup',
  backupOnly: 'checked backup(s) have no primary claims file; the gate reads only the primary, so those reports show as unsampled',
  orphanClaims: 'claims file(s) name no report in the corpus',
  noEconWeight: 'sampled report(s) sit in a domain with no economic weight (for example unrouted) and score 0 on economic relevance',
  noLedger: 'no usage ledger was found; run timing and cost columns are blank',
};

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
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

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

function redactRow(row, redact) {
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
// Shareable tier: a whitelist projection. Each field is an enum value, a finite number, an ISO date, a configured
// domain id or the opaque id; nothing is copied as text. The scan below checks the rendered files again.
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?Z)?$/;
const enumOf = (field, v) => (v === null || v === undefined ? null : ENUMS[field].includes(v) ? v : OTHER);
const dateOf = (v) => (typeof v === 'string' && ISO_RE.test(v) ? v : null);
const numOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const domainOf = (v) => (v === null || v === undefined ? null : PUBLIC_DOMAINS.has(v) ? v : OTHER);
const OPAQUE_ID_RE = /^[0-9a-f]{12}$/;

export function shareRow(row) {
  const out = { row_id: OPAQUE_ID_RE.test(row.row_id) ? row.row_id : null, domain: domainOf(row.domain), ledger_domain: domainOf(row.ledger_domain) };
  for (const f of Object.keys(ENUMS)) out[f] = enumOf(f, row[f]);
  for (const f of SHARE_DATES) out[f] = dateOf(row[f]);
  for (const f of SHARE_NUMBERS) out[f] = numOf(row[f]);
  out.rank_score = row.rank_score === 'unranked' ? 'unranked' : numOf(row.rank_score);
  out.producer_model_recorded = row.producer_model && row.producer_model !== 'unknown' ? 'yes' : 'no';
  out.checker_recorded = row.release === 'unsampled' ? null : row.checker ? 'yes' : 'no';
  return Object.fromEntries(SHARE_COLUMNS.map((c) => [c, out[c] ?? null]));
}

// The words the shareable tier may contain, all defined in this file: its fixed text, column names, enum values,
// role ids, reader phrases and the public domain ids. Nothing from private configuration or the corpus is added.
// Numbers, ISO date pieces and opaque ids are allowed by shape; JSON's null is allowed for empty fields.
export function shareVocabulary() {
  const sources = [TEXT, PROBLEMS, READERS, ENUMS, SHARE_COLUMNS, SHARE_ROLE_COLUMNS, Object.keys(ROLES), PUBLIC_DOMAIN_IDS,
    [OTHER, 'unranked', 'yes', 'no', 'null']];
  return new Set(JSON.stringify(sources).toLowerCase().match(/[a-z0-9]+/g));
}

const SHAPE_RE = /^(\d+|\d+[tz]\d*|[0-9a-f]{12})$/;

// Counts only, never the offending text: an error message must not repeat what it refuses to write.
export function shareableScan(text, vocabulary) {
  const nonAscii = (String(text).match(/[^\t\n\r\x20-\x7e]/g) ?? []).length;
  const unknownWords = (String(text).match(/[A-Za-z0-9]+/g) ?? []).filter((w) => !vocabulary.has(w.toLowerCase()) && !SHAPE_RE.test(w.toLowerCase())).length;
  return { nonAscii, unknownWords, ok: nonAscii === 0 && unknownWords === 0 };
}

// ---------------------------------------------------------------------------------------------
// Front matter, ledger and claim facts.
export function parseFrontMatter(text) {
  const s = String(text);
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: s };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s?(.*)$/);
    if (!kv) continue;
    const raw = kv[2].trim();
    // Titles are written JSON-quoted; a hand-edited value that is not valid JSON is kept as written.
    meta[kv[1]] = raw.startsWith('"') && isJsonString(raw) ? JSON.parse(raw) : raw;
  }
  return { meta, body: s.slice(m[0].length) };
}

function isJsonString(raw) {
  try { return typeof JSON.parse(raw) === 'string'; } catch { return false; }
}

// Runs from the usage ledger with how each ended: the first done/abandoned record under the same title
// before a retry under that title (`at` is when an abandoned run stopped). The ledger is the authority.
export function ledgerRuns(ledger) {
  const rows = [...ledger].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const runs = rows.filter((r) => r.type === 'run').map((run) => {
    const next = rows.find((r) => r.type === 'run' && r.title === run.title && r.ts > run.ts);
    const end = rows.filter((r) => (r.type === 'done' || r.type === 'abandoned') && r.title === run.title)
      .map((r) => ({ type: r.type, ts: r.at ?? r.ts }))
      .filter((e) => e.ts >= run.ts && (!next || e.ts <= next.ts))
      .sort((a, b) => a.ts.localeCompare(b.ts))[0] ?? null;
    const status = !end ? 'open' : end.type === 'done' ? 'done' : 'abandoned';
    return { title: run.title, domain: run.domain ?? null, started: run.ts, finished: status === 'done' ? end.ts : null, status };
  });
  const titles = new Set(runs.map((r) => r.title));
  const orphanCloseTitles = rows.filter((r) => (r.type === 'done' || r.type === 'abandoned') && !titles.has(r.title)).map((r) => r.title);
  return { runs, orphanCloses: orphanCloseTitles.length, orphanCloseTitles };
}

// A report is exported up to this long after its run is marked done.
const RUN_MATCH_GRACE_MS = 2 * HOUR_MS;
const OPEN_RUN_SPAN_MS = 6 * HOUR_MS;
const MIN_TITLE_WORDS = 3;

// One title contains the other as whole words, and the report title is long enough to mean something.
function titlesOverlap(reportTitle, runTitle) {
  const t = phraseOf(reportTitle);
  const r = phraseOf(runTitle);
  return t.split(' ').length >= MIN_TITLE_WORDS && (` ${r} `.includes(` ${t} `) || ` ${t} `.includes(` ${r} `));
}

// The report was created between the run's start and its end (or the open-run span) plus the grace.
function inRunWindow(created, run) {
  const start = Date.parse(run.started);
  const end = run.finished ? Date.parse(run.finished) : start + OPEN_RUN_SPAN_MS;
  return created >= start && created <= end + RUN_MATCH_GRACE_MS;
}

// A run matches a report when their titles overlap and the report was created in the run's window. An abandoned
// run produced no report by definition.
export function matchRun(report, runs) {
  const created = Date.parse(report.created);
  if (Number.isNaN(created)) return null;
  const hits = runs.filter((run) => run.status !== 'abandoned' && titlesOverlap(report.title, run.title) && inRunWindow(created, run));
  const endOf = (run) => Date.parse(run.finished ?? run.started);
  return hits.sort((a, b) => Math.abs(created - endOf(a)) - Math.abs(created - endOf(b)))[0] ?? null;
}

// Runs that belong to excluded reports, in any status: every run whose title overlaps an excluded report's, and every
// run in the excluded report's domain whose window holds its creation time, unless that run's title matches a kept
// report. They are dropped before any ledger table, count or cost average is computed.
export function excludedRuns(runs, excluded, kept) {
  const keptRuns = new Set(kept.map((f) => matchRun(f, runs)).filter(Boolean));
  const dropped = new Set();
  for (const f of excluded) {
    const created = Date.parse(f.created);
    for (const run of runs) {
      const byTitle = titlesOverlap(f.title, run.title);
      const byDomainTime = !keptRuns.has(run) && run.domain === f.domain && !Number.isNaN(created) && inRunWindow(created, run);
      if (byTitle || byDomainTime) dropped.add(run);
    }
  }
  return dropped;
}

// The usage plan over the kept runs only. Costs are measured on the whole ledger, so an excluded run still makes an
// overlapping kept run unmeasurable rather than inflating its cost; the excluded runs' own costs are then dropped.
function keptPlan(ledger, dropped) {
  const full = usagePlan(ledger);
  const isDropped = (c) => [...dropped].some((r) => r.title === c.title && r.domain === (c.domain ?? null));
  const costs = full.costs.filter((c) => !isDropped(c));
  const mean = (k) => (costs.length ? costs.reduce((s, c) => s + c[k], 0) / costs.length : null);
  return { measuredRuns: costs.length, costs, sessionPerRun: mean('session'), weeklyPerRun: mean('weekly') };
}

// Line endings are normalized first, as the verifier does, so a file saved with CRLF or lone CR keeps its
// source, Drive id and exclusion status.
function reportFacts(key, text, exclusionIds) {
  const { meta, body } = parseFrontMatter(normalizeEol(text));
  const fromFm = meta.evidence !== undefined && meta.source_urls !== undefined && meta.source_hosts !== undefined;
  const computed = fromFm ? null : evidenceStats(body);
  const driveId = meta.source === 'google-drive' ? meta.source_id ?? null : null;
  return {
    key, body, title: meta.title ?? key, domain: meta.domain ?? key.split('/')[0], kind: meta.kind ?? 'unknown',
    source: meta.source ?? 'unknown', created: meta.created ?? meta.modified ?? null,
    producer: meta.producer ?? null, model: meta.model ?? null, mode: meta.mode ?? null, driveId,
    sourceUrls: fromFm ? Number(meta.source_urls) : computed.urls,
    sourceHosts: fromFm ? Number(meta.source_hosts) : computed.hosts,
    evidence: fromFm ? meta.evidence : computed.cited ? 'cited' : 'uncited',
    evidenceBasis: fromFm ? 'front-matter' : 'computed-by-registry',
    excludedId: Boolean(meta.source_id && exclusionIds.has(meta.source_id)),
  };
}

function ledgerColumns(run, { ledgerPresent, costs, runs }) {
  const base = { run_started: null, run_finished: null, ledger_run_status: null, ledger_domain: null, window_pct_cost: null, weekly_pct_cost: null };
  if (!ledgerPresent) return { ...base, cost_basis: 'no-ledger' };
  if (!run) return { ...base, cost_basis: 'no-ledger-run' };
  const cols = { ...base, run_started: run.started, run_finished: run.finished, ledger_run_status: run.status, ledger_domain: run.domain };
  const twins = runs.filter((r) => r.title === run.title && r.domain === run.domain).length;
  const cost = costs.find((c) => c.title === run.title && (c.domain ?? null) === run.domain);
  if (twins > 1) return { ...cols, cost_basis: 'ambiguous-repeated-title' };
  if (!cost) return { ...cols, cost_basis: 'not-measured' };
  return { ...cols, cost_basis: 'measured', window_pct_cost: cost.session, weekly_pct_cost: cost.weekly };
}

const CLAIM_NULLS = {
  claims_in_report: null, claims_sampled: null, claims_checked: null, claims_verified: null, claims_partial: null,
  claims_contradicted: null, claims_unsupported: null, claims_garbled: null, claims_unreachable: null, claims_pending: null,
  verified_rate: null, supported_rate: null, release_blocks: [], checker: null, checked_at: null,
};

// The verdict is scoreClaims' own, given the same inputs `verify score` gives it. Anything that stops it
// from running blocks the report: the gate fails closed.
function claimColumns(set, facts, text) {
  if (!set) return { ...CLAIM_NULLS, release: 'unsampled', claims_backup: 'none' };
  // The gate reads only the primary claims file, so a report with nothing but a backup is unsampled.
  if (set.backupOnly) return { ...CLAIM_NULLS, release: 'unsampled', claims_backup: 'backup-only' };
  if (set.error) return { ...CLAIM_NULLS, release: 'blocked', release_blocks: [set.error], claims_backup: set.backup };
  let score;
  try {
    score = scoreClaims(set.records, { reportKey: facts.key, reportText: text, manifest: set.manifest });
  } catch (e) {
    return { ...CLAIM_NULLS, release: 'blocked', release_blocks: [`scoring failed: ${e.message}`], claims_backup: set.backup };
  }
  const stamps = set.records.map((r) => r.checked_at).filter((t) => !Number.isNaN(Date.parse(t))).sort();
  const s = score.byStatus;
  return {
    // Every claim the report makes in any extraction mode, so sampling a narrow mode cannot inflate coverage.
    claims_in_report: extractClaims(text, { from: 'all' }).length, claims_sampled: score.total, claims_checked: score.checked,
    claims_verified: s.verified, claims_partial: s.partial, claims_contradicted: s.contradicted, claims_unsupported: s.unsupported,
    claims_garbled: s.garbled, claims_unreachable: s.unreachable, claims_pending: s.pending,
    verified_rate: score.verifiedRate, supported_rate: score.supportedRate, release: score.release, release_blocks: score.blocks,
    checker: [...new Set(set.records.map((r) => r.checker).filter(Boolean))].join('; ') || null,
    checked_at: stamps.at(-1) ?? null, claims_backup: set.backup,
  };
}

const round1 = (x) => +x.toFixed(1);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function scoreColumns(row, { staleDays, econWeight }) {
  const sampled = row.release !== 'unsampled';
  const breadth = WEIGHTS.sourceBreadth * clamp01((row.source_hosts ?? 0) / HOSTS_FOR_FULL_CREDIT);
  const freshness = row.age_days === null ? 0
    : WEIGHTS.freshness * clamp01(1 - Math.max(0, row.age_days - staleDays) / (FRESHNESS_DECAY_WINDOWS * staleDays));
  const economic = WEIGHTS.economicRelevance * clamp01(econWeight);
  if (!sampled) {
    return { score_evidence_integrity: null, score_source_breadth: round1(breadth), score_freshness: round1(freshness),
      score_verification_coverage: null, score_economic_relevance: round1(economic), rank_score: 'unranked' };
  }
  const checked = row.claims_checked ?? 0;
  const inReport = row.claims_in_report ?? 0;
  const sampleCredit = clamp01(checked / Math.min(SAMPLE_FOR_FULL_CREDIT, Math.max(1, inReport)));
  const integrity = WEIGHTS.evidenceIntegrity * (row.verified_rate ?? 0) * sampleCredit;
  const coverage = inReport ? WEIGHTS.verificationCoverage * clamp01(checked / inReport) : 0;
  return {
    score_evidence_integrity: round1(integrity), score_source_breadth: round1(breadth), score_freshness: round1(freshness),
    score_verification_coverage: round1(coverage), score_economic_relevance: round1(economic),
    rank_score: Math.round(integrity + breadth + freshness + coverage + economic),
  };
}

function keywordHits(phrase, keywords) {
  const padded = ` ${phrase} `;
  return keywords.filter((k) => (k.endsWith('*') ? padded.includes(` ${phraseOf(k.slice(0, -1))}`) : padded.includes(` ${phraseOf(k)} `)));
}

export function roleRelevance(domain, { title, headings }, roleDomains = {}) {
  const t = phraseOf(title);
  const h = phraseOf(headings);
  return Object.fromEntries(Object.entries(ROLES).map(([role, def]) => {
    const local = roleDomains[role] ?? {};
    const base = local[domain] ?? def.domains[domain] ?? local['*'] ?? def.domains['*'] ?? 0;
    const inTitle = keywordHits(t, def.keywords).length ? 1 : 0;
    const inHeadings = keywordHits(h, def.keywords).length >= 2 ? 1 : 0;
    return [role, Math.min(3, base + inTitle + inHeadings)];
  }));
}

function headingsOf(body) {
  return [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].slice(0, 60).map((m) => m[1]).join(' \n ');
}

// ---------------------------------------------------------------------------------------------
// The registry: pure, so every rule above is testable on synthetic data. Exclusion is decided first, over every
// report, and excluded documents are dropped before any row, ledger run, cost average, count or claim diagnostic
// is computed, so neither tier can carry them.

// The pipeline's own exclusion test (lib.mjs classifyKind): a title containing a personal pattern (the defaults
// plus exclude.txt, as a case-insensitive substring) is 'personal'; one matching SENSITIVE_RE is 'sensitive'.
export function pipelineExcludes(title, personalPatterns = DEFAULT_PERSONAL_PATTERNS) {
  return ['personal', 'sensitive'].includes(classifyKind({ title: String(title ?? '') }, personalPatterns));
}

// Excluded: a listed Drive id, a quarantined key, the pipeline's own test, or (stricter than the pipeline) an
// exclusion pattern matching whole words once separators, case and Unicode forms are normalized.
function isExcluded({ key, f }, { quarantineKeys, personalPatterns, redact }) {
  return f.excludedId || quarantineKeys.has(key) || pipelineExcludes(f.title, personalPatterns)
    || redact(`${f.title}\n${key}`).hits.has('exclusion');
}

// Row ids are a pseudonym keyed by a private salt, so a reader who can guess a corpus key cannot confirm it.
export const rowIdFor = (key, salt) => createHmac('sha256', String(salt)).update(String(key)).digest('hex').slice(0, 12);
const freshSalt = () => randomBytes(32).toString('hex');

function reportRow(f, key, text, run, ctx) {
  const created = Date.parse(f.created);
  const raw = {
    row_id: rowIdFor(key, ctx.idSalt), key, title: f.title, domain: f.domain, kind: f.kind, source: f.source,
    created: f.created, age_days: Number.isNaN(created) ? null : Math.max(0, Math.floor((ctx.now - created) / DAY_MS)),
    producer: f.producer ?? (run ? 'gemini-deep-research' : 'unknown'),
    producer_mode: f.mode ?? (run ? 'deep-research' : 'unknown'), producer_model: f.model ?? 'unknown',
    producer_basis: run ? 'usage-ledger' : f.producer ? 'front-matter-classifier' : 'none',
    ...ledgerColumns(run, ctx),
    drive_doc_id: f.driveId, drive_doc_url: f.driveId ? `https://drive.google.com/open?id=${encodeURIComponent(f.driveId)}` : null,
    local_path: `corpus/${key}`, source_urls: f.sourceUrls, source_hosts: f.sourceHosts, evidence: f.evidence, evidence_basis: f.evidenceBasis,
    ...claimColumns(ctx.claimSets.get(key), f, text),
  };
  raw.release_block_count = raw.release_blocks.length;
  raw.sampled_share = raw.claims_in_report ? +(raw.claims_sampled / raw.claims_in_report).toFixed(3) : null;
  return Object.assign(raw, scoreColumns(raw, { staleDays: ctx.stale.get(f.domain) ?? DEFAULT_STALE_DAYS, econWeight: ctx.econ[f.domain] ?? 0 }));
}

export function buildRegistry({
  reports, ledger = null, claimSets = new Map(), domains = [], local = {}, exclusionIds = new Set(), quarantineKeys = new Set(),
  personalPatterns = DEFAULT_PERSONAL_PATTERNS, redact = makeRedactor(), now = Date.now(), orphanClaimFiles = [], idSalt = freshSalt(),
}) {
  const stale = new Map();
  for (const d of domains) if (!stale.has(d.id)) stale.set(d.id, d.staleDays);
  const econ = { ...ECONOMIC_DOMAIN_WEIGHTS, ...(local.economicDomainWeights ?? {}) };
  const all = [...reports].sort((a, b) => a.key.localeCompare(b.key)).map(({ key, text }) => ({ key, text, f: reportFacts(key, text, exclusionIds) }));
  const excluded = all.filter((r) => isExcluded(r, { quarantineKeys, personalPatterns, redact }));
  const kept = all.filter((r) => !excluded.includes(r));
  const ledgerFacts = ledger ? ledgerRuns(ledger) : { runs: [], orphanCloseTitles: [] };
  const dropped = excludedRuns(ledgerFacts.runs, excluded.map((r) => r.f), kept.map((r) => r.f));
  const runs = ledgerFacts.runs.filter((r) => !dropped.has(r));
  const orphanCloses = ledgerFacts.orphanCloseTitles.filter((t) => !excluded.some((r) => titlesOverlap(r.f.title, t))).length;
  const plan = ledger ? keptPlan(ledger, dropped) : null;
  const keptKeys = new Set(kept.map((r) => r.key));
  const keptSets = new Map([...claimSets].filter(([k]) => keptKeys.has(k)));
  const ctx = { ledgerPresent: Boolean(ledger), costs: plan?.costs ?? [], runs, now, stale, econ, claimSets: keptSets, idSalt };
  const out = { rows: [], roleRows: [], shareRows: [], shareRoleRows: [] };
  const matched = new Map();
  for (const { key, text, f } of kept) {
    const run = matchRun(f, runs);
    const raw = reportRow(f, key, text, run, ctx);
    if (run) matched.set(run, raw);
    const relevance = roleRelevance(f.domain, { title: f.title, headings: headingsOf(f.body) }, local.roleDomains);
    const [human, agent] = readers(raw);
    const share = shareRow(raw);
    out.shareRows.push(share);
    out.shareRoleRows.push({ row_id: share.row_id, domain: share.domain, kind: share.kind, evidence: share.evidence, release: share.release,
      ...relevance, human_reader: human, agent_reader: agent });
    const { row, hits } = redactRow(raw, redact);
    row.privacy = hits.has('denylist') ? 'redacted' : 'ok';
    out.rows.push(Object.fromEntries(PRIVATE_COLUMNS.map((c) => [c, row[c] ?? null])));
    out.roleRows.push({ row_id: row.row_id, key: row.key, title: row.title, domain: row.domain, kind: row.kind,
      evidence: row.evidence, release: row.release, ...relevance, human_reader: human, agent_reader: agent });
  }
  const reportOf = (r, idOf) => (matched.has(r) ? idOf(matched.get(r)) : null);
  const runRows = runs.map((r) => ({ ...r, title: redact(r.title).text, report: reportOf(r, (raw) => redact(raw.key, 'redacted').text) }));
  const shareRuns = runs.map((r) => ({ domain: domainOf(r.domain), status: enumOf('ledger_run_status', r.status),
    started: dateOf(r.started), finished: dateOf(r.finished), report: reportOf(r, (raw) => raw.row_id) }));
  // A claims file left by an excluded or quarantined report is not reported as an orphan either.
  const excludedStems = new Set([...excluded.map((r) => r.key), ...quarantineKeys].map(stemOf));
  const orphans = orphanClaimFiles.filter((name) => !excludedStems.has(name.replace(/\.claims\.jsonl$/, '')));
  const problems = findProblems({ rows: out.rows, runRows, orphanCloses, claimSets: keptSets, orphanClaimFiles: orphans, econ,
    withheld: excluded.length, ledgerPresent: Boolean(ledger) });
  return { ...out, runRows, shareRuns, plan, problems, econ, withheld: excluded.length };
}

// Problems are counts with fixed text. The withheld count is the one that can point at a document, so the
// shareable tier shows it as "a few" when it is 1 to 3.
const SMALL_COUNT = 3;
const countLabel = (n, shareable) => (shareable && n > 0 && n <= SMALL_COUNT ? TEXT.aFew : String(n));

function findProblems({ rows, runRows, orphanCloses, claimSets, orphanClaimFiles, econ, withheld, ledgerPresent }) {
  const count = (pred) => rows.filter(pred).length;
  const sets = [...claimSets.values()].filter((s) => !s.backupOnly);
  const checks = [
    [sets.filter((s) => !s.error && !s.manifest).length, PROBLEMS.noManifest],
    [sets.filter((s) => s.error).length, PROBLEMS.unreadable],
    [count((r) => r.release_blocks.some((b) => b.startsWith('scoring failed'))), PROBLEMS.scoringFailed],
    [count((r) => r.ledger_domain && r.ledger_domain !== r.domain), PROBLEMS.domainDiffers],
    [count((r) => r.cost_basis === 'not-measured'), PROBLEMS.notMeasured],
    [runRows.filter((r) => r.status === 'open').length, PROBLEMS.openRuns],
    [orphanCloses, PROBLEMS.orphanCloses],
    [runRows.filter((r) => r.status === 'done' && !r.report).length, PROBLEMS.unmatchedRuns],
    [count((r) => r.evidence_basis === 'computed-by-registry'), PROBLEMS.computedEvidence],
    [withheld, PROBLEMS.withheld],
    [count((r) => r.claims_backup === 'differs'), PROBLEMS.backupDiffers],
    [count((r) => r.claims_backup === 'backup-only'), PROBLEMS.backupOnly],
    [orphanClaimFiles.length, PROBLEMS.orphanClaims],
    [count((r) => r.release !== 'unsampled' && !(econ[r.domain] > 0)), PROBLEMS.noEconWeight],
    [ledgerPresent ? 0 : 1, PROBLEMS.noLedger],
  ];
  return checks.filter(([n]) => n > 0).map(([n, text]) => ({ n, text }));
}

const problemLines = (problems, shareable) => problems.map(({ n, text }) => `${text === PROBLEMS.withheld ? countLabel(n, shareable) : n} ${text}.`);

// ---------------------------------------------------------------------------------------------
// Rendering.
// A spreadsheet must never run a cell as a formula: a cell that opens with tab, CR or LF, or whose first character
// after any leading whitespace or control characters is = + - @ or a full-width form of one, gets a leading quote.
const FORMULA_LEAD = /^(?:[\t\r\n]|[\s\p{Cc}\p{Cf}]*[=+\-@＝＋－＠])/u;

function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let s = Array.isArray(v) ? v.join('; ') : String(v);
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  return `${[columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n')}\n`;
}

const fmt = (template, values) => template.replace(/\{(\w+)\}/g, (_, k) => String(values[k]));
const cell = (v) => (v === null || v === undefined || v === '' ? '' : String(v).replace(/\|/g, '\\|').replace(/\s+/g, ' '));
const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)];
const presample = (r) => r.score_source_breadth + r.score_freshness + r.score_economic_relevance;
const H = TEXT.head;

function summaryLines(rows, runRows, withheld, shareable) {
  const n = (pred) => rows.filter(pred).length;
  const S = TEXT.summary;
  return mdTable([H.measure, H.count], [
    [S.reports, rows.length],
    [S.kinds, `${n((r) => r.kind === 'deep-research')} / ${n((r) => r.kind === 'gemini-canvas')} / ${n((r) => !['deep-research', 'gemini-canvas'].includes(r.kind))}`],
    [S.cited, n((r) => r.evidence === 'cited')],
    [S.sampled, n((r) => r.release !== 'unsampled')],
    [S.release, `${n((r) => r.release === 'pass')} / ${n((r) => r.release === 'blocked')} / ${n((r) => r.release === 'unsampled')}`],
    [S.ledger, `${runRows.length} / ${n((r) => r.ledger_run_status)} / ${n((r) => r.cost_basis === 'measured')}`],
    [S.withheld, countLabel(withheld, shareable)],
    ...(shareable ? [] : [[S.redacted, n((r) => r.privacy === 'redacted')]]),
  ]);
}

// The shareable tier shows the generic components and rules only; the per-domain weights (whose keys and values may
// come from private configuration) are listed in the private tier alone.
function weightLines(econ, localKeys, shareable) {
  const domainList = Object.entries(econ).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([d, w]) => `${d} ${w}${localKeys.has(d) ? ` ${TEXT.local}` : ''}`).join('; ');
  const C = TEXT.component;
  const R = TEXT.rule;
  return [
    ...mdTable([H.component, H.max, H.rule], [
      [C.integrity, WEIGHTS.evidenceIntegrity, fmt(R.integrity, { s: SAMPLE_FOR_FULL_CREDIT })],
      [C.breadth, WEIGHTS.sourceBreadth, fmt(R.breadth, { h: HOSTS_FOR_FULL_CREDIT })],
      [C.freshness, WEIGHTS.freshness, fmt(R.freshness, { d: DEFAULT_STALE_DAYS, w: FRESHNESS_DECAY_WINDOWS })],
      [C.coverage, WEIGHTS.verificationCoverage, R.coverage],
      [C.economic, WEIGHTS.economicRelevance, R.economic],
    ]),
    '', shareable ? TEXT.econPrivateOnly : fmt(TEXT.econ, { list: domainList }),
  ];
}

function ledgerLines(runRows, plan, ledgerPresent, shareable) {
  if (!ledgerPresent) return [TEXT.noLedger];
  const mean = (x) => (x === null || x === undefined ? TEXT.na : `${+x.toFixed(1)}%`);
  const head = [...(shareable ? [] : [H.runTitle]), H.ledgerDomain, H.status, H.started, H.finished, H.matched];
  return [
    fmt(TEXT.measured, { n: plan.measuredRuns, s: mean(plan.sessionPerRun), w: mean(plan.weeklyPerRun) }), '',
    ...mdTable(head, runRows.map((r) => [...(shareable ? [] : [r.title]), r.domain, r.status, r.started, r.finished ?? '', r.report ?? ''])),
  ];
}

// One renderer for both tiers. The shareable tier passes its own rows, runs and role rows only, and names each
// report by its opaque id; the private tier names it by corpus key.
export function registryMarkdown({ tier, rows, roleRows, runRows, plan, problems, econ, localKeys = new Set(), builtAt, withheld, nameCheck, ledgerPresent }) {
  const shareable = tier === 'shareable';
  const id = (r) => (shareable ? r.row_id : r.key);
  const byId = (a, b) => String(id(a)).localeCompare(String(id(b)));
  const ranked = rows.filter((r) => r.release !== 'unsampled').sort((a, b) => b.rank_score - a.rank_score || byId(a, b));
  const queue = rows.filter((r) => r.release === 'unsampled' && r.evidence === 'cited').sort((a, b) => presample(b) - presample(a) || byId(a, b));
  const roleCounts = Object.keys(ROLES).map((role) => [role, roleRows.filter((r) => r[role] >= 2).length, roleRows.filter((r) => r[role] === 3).length]);
  const order = { pass: 0, blocked: 1, unsampled: 2 };
  const all = [...rows].sort((a, b) => (order[a.release] ?? 3) - (order[b.release] ?? 3) || byId(a, b));
  return [
    shareable ? TEXT.headShare : TEXT.headPrivate, '', shareable ? TEXT.noteShare : TEXT.notePrivate, '', TEXT.hypotheses, '',
    `${fmt(TEXT.built, { at: builtAt, n: rows.length, w: countLabel(withheld, shareable) })}${shareable ? '' : ` ${TEXT.paths}`}`, '',
    nameCheck, '',
    TEXT.hSummary, '', ...summaryLines(rows, runRows, withheld, shareable), '',
    TEXT.hWeights, '', ...weightLines(econ, localKeys, shareable), '',
    TEXT.hRanked, '',
    ...mdTable([H.rank, H.report, H.domain, H.release, H.vci, H.share, H.integrity, H.breadth, H.fresh, H.coverage, H.econ, H.blocks],
      ranked.map((r) => [r.rank_score, id(r), r.domain, r.release, `${r.claims_verified ?? 0} / ${r.claims_checked ?? 0} / ${r.claims_in_report ?? TEXT.na}`,
        r.sampled_share, r.score_evidence_integrity, r.score_source_breadth, r.score_freshness, r.score_verification_coverage, r.score_economic_relevance,
        r.release_block_count])), '',
    TEXT.hQueue, '', TEXT.queueNote, '',
    ...mdTable([H.report, H.domain, H.kind, H.hosts, H.breadth, H.fresh, H.econ],
      queue.map((r) => [id(r), r.domain, r.kind, r.source_hosts, r.score_source_breadth, r.score_freshness, r.score_economic_relevance])), '',
    TEXT.hLedger, '', ...ledgerLines(runRows, plan, ledgerPresent, shareable), '',
    TEXT.hProblems, '', ...(problems.length ? problemLines(problems, shareable).map((p) => `- ${p}`) : [TEXT.none]), '',
    TEXT.hRoles, '', ...mdTable([H.role, H.rel2, H.rel3], roleCounts), '',
    TEXT.hAll, '',
    ...mdTable([H.report, H.kind, H.domain, H.evidence, H.release, H.rank], all.map((r) => [id(r), r.kind, r.domain, r.evidence, r.release, r.rank_score])), '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// I/O: reads RESEARCH_HOME, writes only RESEARCH_HOME/registry/.
function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
}

// Exactly how corpus.mjs reads a claims file or the usage ledger (its readJsonl and readUsage): split on LF or
// CRLF, drop only empty lines, parse every other line. A whitespace-only line fails there, so it fails here, and
// the registry's release verdict stays the one `verify score` gives. corpus.mjs runs its CLI on import, so
// the loader is replicated here rather than imported; keep the two identical.
export function parseJsonl(text) {
  return String(text).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function readJsonl(file) {
  try { return parseJsonl(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${path.basename(file)}: ${e.message}`); }
}

function listMarkdown(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? listMarkdown(full) : name.endsWith('.md') ? [full] : [];
  });
}

const keysUnder = (dir) => listMarkdown(dir).map((file) => path.relative(dir, file).split(path.sep).join('/'));
const stemOf = (key) => key.replace(/\.md$/, '').split('/').join('__');

// The same files `verify score` reads: <stem>.claims.jsonl and <stem>.manifest.json. The checked backup is
// compared, never scored, because the gate does not read it.
function readClaimSet(verifyDir, key) {
  const stem = path.join(verifyDir, stemOf(key));
  const primary = `${stem}.claims.jsonl`;
  const backupFile = `${stem}.claims.checked-backup.jsonl`;
  const hasBackup = existsSync(backupFile);
  if (!existsSync(primary)) return hasBackup ? { backupOnly: true } : null;
  const backup = !hasBackup ? 'none' : readFileSync(backupFile, 'utf8') === readFileSync(primary, 'utf8') ? 'identical' : 'differs';
  try {
    const records = readJsonl(primary);
    const manifestFile = `${stem}.manifest.json`;
    return { records, manifest: existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null, backup };
  } catch (e) {
    return { error: `claims file unreadable: ${e.message}`, backup };
  }
}

export function loadHome(home) {
  const corpusDir = path.join(home, 'corpus');
  const verifyDir = path.join(home, 'verify');
  const reports = keysUnder(corpusDir).map((key) => ({ key, text: readFileSync(path.join(corpusDir, ...key.split('/')), 'utf8') }));
  const claimSets = new Map();
  for (const { key } of reports) {
    const set = readClaimSet(verifyDir, key);
    if (set) claimSets.set(key, set);
  }
  const stems = new Set(reports.map((r) => stemOf(r.key)));
  const orphanClaimFiles = existsSync(verifyDir)
    ? readdirSync(verifyDir).filter((f) => f.endsWith('.claims.jsonl') && !stems.has(f.replace(/\.claims\.jsonl$/, ''))) : [];
  const usage = path.join(home, 'gemini-usage.jsonl');
  const redactFile = path.join(home, 'registry', 'redact.sha256.txt');
  const weightsFile = path.join(home, 'registry', 'weights.local.json');
  const exclusionPhrases = readLines(path.join(home, 'exclude.txt'));
  return {
    reports, claimSets, orphanClaimFiles, exclusionPhrases,
    ledger: existsSync(usage) ? readJsonl(usage) : null,
    domains: [...readJson(path.join(home, 'domains.local.json'), { domains: [] }).domains, ...readJson(path.join(HERE, 'domains.json'), { domains: [] }).domains],
    local: validateLocalWeights(readJson(weightsFile, {}), weightsFile),
    exclusionIds: new Set(readLines(path.join(home, 'exclude-ids.txt'))),
    quarantineKeys: new Set(keysUnder(path.join(home, 'quarantine'))),
    // The same list corpus.mjs classifies with: the default personal patterns plus exclude.txt.
    personalPatterns: [...DEFAULT_PERSONAL_PATTERNS, ...exclusionPhrases],
    denylist: existsSync(redactFile) ? parseRedactList(readFileSync(redactFile, 'utf8')) : null,
    redactFile,
  };
}

// Local weights are numbers only, so configuration cannot smuggle text into a score. The error names the file, not
// the offending key or value.
export function validateLocalWeights(local, file = 'weights.local.json') {
  for (const w of Object.values(local.economicDomainWeights ?? {})) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 1) throw new Error(`${file}: every economic domain weight must be a number from 0 to 1`);
  }
  for (const bases of Object.values(local.roleDomains ?? {})) {
    for (const b of Object.values(bases ?? {})) {
      if (!Number.isInteger(b) || b < 0 || b > 2) throw new Error(`${file}: every role domain base must be 0, 1 or 2`);
    }
  }
  return local;
}

// The row-id salt: 32 random bytes, created on the first build and kept in the private tier (owner-only where the
// file system honours it). Ids are stable while it exists; deleting it re-keys every id.
const SALT_FILE = '.id-salt';
const SALT_RE = /^[0-9a-f]{64}$/;

export function idSaltFor(home) {
  const file = path.join(home, 'registry', 'private', SALT_FILE);
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${freshSalt()}\n`, { mode: 0o600, flag: 'wx' });
  }
  const salt = readFileSync(file, 'utf8').trim();
  if (!SALT_RE.test(salt)) throw new Error(`${file} is not a 64-hex-digit salt; delete it to create a new one (every row id will change)`);
  return salt;
}

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// Builds before this layout wrote the private files to registry/ itself, through `<name>.tmp`; both the files and
// any temporary file an interrupted write left behind are removed, so no stale private copy sits where people look
// for something to share. Leftover temporary files in the tier folders go too.
const OUTPUT_NAMES = ['reports.csv', 'reports.jsonl', 'roles.csv', 'REGISTRY.md'];
const LEGACY_OUTPUTS = OUTPUT_NAMES.flatMap((n) => [n, `${n}.tmp`]);
const STALE_TIER_TEMPS = ['private', 'shareable'].flatMap((t) => OUTPUT_NAMES.map((n) => `${t}/${n}.tmp`));

function tierFiles(tier, { rows, roleRows, columns, roleColumns, markdown }) {
  return {
    [`${tier}/reports.csv`]: toCsv(rows, columns),
    [`${tier}/reports.jsonl`]: `${rows.map((r) => JSON.stringify(r)).join('\n')}${rows.length ? '\n' : ''}`,
    [`${tier}/roles.csv`]: toCsv(roleRows, roleColumns),
    [`${tier}/REGISTRY.md`]: markdown,
  };
}

export function runBuild({ home, allowUnredacted = false, now = Date.now() }) {
  const input = loadHome(home);
  if (!input.denylist && !allowUnredacted) {
    throw new Error(`no redaction list at ${input.redactFile}: the private tier could name people. Add hashes with "node registry.mjs redact-hash", or pass --allow-unredacted`);
  }
  const redact = makeRedactor({ entries: input.denylist ?? [], phrases: input.exclusionPhrases });
  const reg = buildRegistry({ ...input, redact, now, idSalt: idSaltFor(home) });
  const common = { plan: reg.plan, problems: reg.problems, econ: reg.econ, builtAt: new Date(now).toISOString(), withheld: reg.withheld,
    ledgerPresent: Boolean(input.ledger), localKeys: new Set(Object.keys(input.local.economicDomainWeights ?? {})) };
  const privateCheck = input.denylist
    ? fmt(TEXT.checkedPrivate, { d: input.denylist.length, p: input.exclusionPhrases.length }) : TEXT.uncheckedPrivate;
  const files = {
    ...tierFiles('shareable', { rows: reg.shareRows, roleRows: reg.shareRoleRows, columns: SHARE_COLUMNS, roleColumns: SHARE_ROLE_COLUMNS,
      markdown: registryMarkdown({ ...common, tier: 'shareable', rows: reg.shareRows, roleRows: reg.shareRoleRows, runRows: reg.shareRuns, nameCheck: TEXT.checkedShare }) }),
    ...tierFiles('private', { rows: reg.rows, roleRows: reg.roleRows, columns: PRIVATE_COLUMNS, roleColumns: PRIVATE_ROLE_COLUMNS,
      markdown: registryMarkdown({ ...common, tier: 'private', rows: reg.rows, roleRows: reg.roleRows, runRows: reg.runRows, nameCheck: privateCheck }) }),
  };
  const vocabulary = shareVocabulary();
  const refused = Object.entries(files).flatMap(([name, text]) => {
    const why = [];
    if (redact(text).hits.size) why.push('matches the redaction list');
    if (name.startsWith('shareable/')) {
      const scan = shareableScan(text, vocabulary);
      if (scan.nonAscii) why.push(`${scan.nonAscii} non-ASCII character(s)`);
      if (scan.unknownWords) why.push(`${scan.unknownWords} word(s) outside the registry vocabulary`);
    }
    return why.length ? [`${name}: ${why.join(', ')}`] : [];
  });
  if (refused.length) throw new Error(`share-check failed, nothing was written: ${refused.join('; ')}`);
  const dir = path.join(home, 'registry');
  for (const [name, text] of Object.entries(files)) writeAtomic(path.join(dir, ...name.split('/')), text);
  for (const name of [...LEGACY_OUTPUTS, ...STALE_TIER_TEMPS]) rmSync(path.join(dir, ...name.split('/')), { force: true });
  return { dir, files: Object.keys(files), reports: reg.rows.length, withheld: reg.withheld, problems: reg.problems };
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function main() {
  const home = process.env.RESEARCH_HOME || path.join(homedir(), '.starlight', 'research');
  const cmd = process.argv[2];
  if (cmd === 'build') {
    const out = runBuild({ home, allowUnredacted: process.argv.includes('--allow-unredacted') });
    console.log(JSON.stringify({ dir: out.dir, files: out.files, reports: out.reports, withheld: out.withheld, problems: out.problems.length }, null, 2));
    return;
  }
  if (cmd === 'redact-hash') {
    const phrase = process.argv[3];
    if (!phrase || phrase.startsWith('--')) throw new Error('usage: redact-hash "<phrase>" [--label <label>]');
    const { hash, words } = redactEntry(phrase);
    console.log(`${hash} ${words}  # ${flag('label') ?? 'added'}`);
    return;
  }
  throw new Error('usage: node registry.mjs build [--allow-unredacted] | redact-hash "<phrase>" [--label <label>]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
