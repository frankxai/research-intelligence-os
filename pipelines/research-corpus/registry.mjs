#!/usr/bin/env node
// Research registry: one transparent row per corpus report, a role relevance matrix and REGISTRY.md.
//
//   node registry.mjs build [--allow-unredacted]
//       corpus front matter + Gemini usage ledger + claim records -> RESEARCH_HOME/registry/
//       reports.csv, reports.jsonl, roles.csv, REGISTRY.md
//   node registry.mjs redact-hash "<phrase>" [--label <label>]
//       prints the line to append to RESEARCH_HOME/registry/redact.sha256.txt
//
// Reads RESEARCH_HOME (corpus/, gemini-usage.jsonl, verify/, exclude.txt, exclude-ids.txt, domains.local.json,
// registry/weights.local.json, registry/redact.sha256.txt) and writes only RESEARCH_HOME/registry/.
// The release verdict is the claim gate's own (`corpus.mjs verify score`); the rank only orders review.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evidenceStats, extractClaims, normalizeEol, scoreClaims, usagePlan } from './lib.mjs';

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

export const REPORT_COLUMNS = [
  'row_id', 'key', 'title', 'domain', 'kind', 'source', 'created', 'age_days',
  'producer', 'producer_mode', 'producer_model', 'producer_basis',
  'run_started', 'run_finished', 'ledger_run_status', 'ledger_domain', 'cost_basis', 'window_pct_cost', 'weekly_pct_cost',
  'drive_doc_id', 'drive_doc_url', 'local_path', 'source_urls', 'source_hosts', 'evidence', 'evidence_basis',
  'claims_in_report', 'claims_sampled', 'claims_checked', 'claims_verified', 'claims_partial', 'claims_contradicted',
  'claims_unsupported', 'claims_garbled', 'claims_unreachable', 'claims_pending', 'verified_rate', 'supported_rate',
  'release', 'release_blocks', 'checker', 'checked_at', 'claims_backup', 'privacy',
  'score_evidence_integrity', 'score_source_breadth', 'score_freshness', 'score_verification_coverage', 'score_economic_relevance', 'rank_score',
];
export const ROLE_COLUMNS = ['row_id', 'key', 'title', 'domain', 'kind', 'evidence', 'release', ...Object.keys(ROLES), 'human_reader', 'agent_reader'];

// ---------------------------------------------------------------------------------------------
// Privacy. Every string written is passed through the redactor, and every output is scanned again before
// anything is written. Names are listed as SHA-256 hashes of the normalized phrase, so the list itself names no
// one; hashes of short names are guessable, so the list stays private. exclude.txt patterns redact too.
//
// One tokenizer serves hashing, redaction and the final scan, so a phrase is matched however it is encoded:
// a raw word is a run of letters, digits and combining marks in the original text, folded by compatibility
// decomposition (NFKD: full-width and ligature forms become plain letters), full case folding (upper then
// lower, so "ß" and "SS" agree) and removal of combining marks (composed and decomposed accents agree).
// A raw word can fold into several tokens ("½" -> "1 2"); they share its span.
const RAW_WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;
const FOLDED_WORD_RE = /[\p{L}\p{N}]+/gu;
const fold = (s) => s.normalize('NFKD').toUpperCase().toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function tokens(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(RAW_WORD_RE)) {
    for (const w of fold(m[0]).match(FOLDED_WORD_RE) ?? []) out.push({ start: m.index, end: m.index + m[0].length, w });
  }
  return out;
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

// `<sha256> <word count>  # label` per line; blank lines and # comments are skipped. Any other line stops the
// build: a malformed or count-less entry would otherwise leave its phrase unredacted without a sign.
export function parseRedactList(text) {
  return normalizeEol(text).split('\n').map((l, i) => [l.trim(), i + 1]).filter(([l]) => l && !l.startsWith('#')).map(([l, n]) => {
    const m = l.match(ENTRY_RE);
    if (!m || Number(m[2]) < 1) {
      throw new Error(`redaction list line ${n} is not "<sha256> <word count>  # label": regenerate it with "node registry.mjs redact-hash"`);
    }
    return { hash: m[1], words: Number(m[2]) };
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
    for (const [a, b] of mergeSpans(spans).reverse()) out = `${out.slice(0, a)}${mask}${out.slice(b)}`;
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
  const orphanCloses = rows.filter((r) => (r.type === 'done' || r.type === 'abandoned') && !titles.has(r.title)).length;
  return { runs, orphanCloses };
}

// A report is exported up to this long after its run is marked done.
const RUN_MATCH_GRACE_MS = 2 * HOUR_MS;
const OPEN_RUN_SPAN_MS = 6 * HOUR_MS;
const MIN_TITLE_WORDS = 3;

// A run matches a report when one title contains the other as whole words and the report was created
// between the run's start and its end plus the grace. An abandoned run produced no report by definition.
export function matchRun(report, runs) {
  const t = phraseOf(report.title);
  const created = Date.parse(report.created);
  if (t.split(' ').length < MIN_TITLE_WORDS || Number.isNaN(created)) return null;
  const hits = runs.filter((run) => {
    const r = phraseOf(run.title);
    if (run.status === 'abandoned' || !(` ${r} `.includes(` ${t} `) || ` ${t} `.includes(` ${r} `))) return false;
    const start = Date.parse(run.started);
    const end = run.finished ? Date.parse(run.finished) : start + OPEN_RUN_SPAN_MS;
    return created >= start && created <= end + RUN_MATCH_GRACE_MS;
  });
  const endOf = (run) => Date.parse(run.finished ?? run.started);
  return hits.sort((a, b) => Math.abs(created - endOf(a)) - Math.abs(created - endOf(b)))[0] ?? null;
}

// Line endings are normalized first, as the verifier does, so a file saved with CRLF or lone CR keeps its
// source, Drive id and privacy flag.
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
  const cost = costs.find((c) => c.title === run.title && c.domain === run.domain);
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

// How a person and an agent should consume a report, by what has been checked, not by topic. A pass covers
// only the sampled claims a checker supported; it says nothing about the rest of the report.
export function readers(row) {
  if (row.release === 'pass') return ['Trust only the sampled claims marked verified or partial, as of their check date; the rest is unverified AI synthesis.', 'Use only verified and partial claim records, each with its source and date; treat everything else in the report as unverified.'];
  if (row.release === 'blocked') return ['Read the blocked and contradicted claims first; use it for direction, not numbers.', 'Use only verified claim records; never repeat contradicted or unchecked claims.'];
  if (row.source === 'local-file') return ['Estate document as of its recorded commit; check for a newer version.', 'Cite with path and commit; re-read the source when it may have changed.'];
  if (row.evidence === 'cited') return ['Skim as unverified AI synthesis; check any number before acting on it.', 'Retrieve for orientation only; label every statement unverified-ai-synthesis.'];
  if (row.kind === 'deep-research') return ['Background reading; it cites too few sources to check claim by claim.', 'Context only; never cite it as evidence.'];
  return ['Internal planning notes; read as opinion, not research.', 'Planning context only; do not retrieve it as evidence.'];
}

function headingsOf(body) {
  return [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].slice(0, 60).map((m) => m[1]).join(' \n ');
}

function privacyOf(facts, hits) {
  if (facts.excludedId) return 'excluded-id';
  if (hits.has('exclusion')) return 'exclusion-match';
  return hits.has('denylist') ? 'redacted' : 'ok';
}

// ---------------------------------------------------------------------------------------------
// The registry: pure, so every rule above is testable on synthetic data.
export function buildRegistry({
  reports, ledger = null, claimSets = new Map(), domains = [], local = {}, exclusionIds = new Set(),
  redact = makeRedactor(), now = Date.now(), orphanClaimFiles = [],
}) {
  const stale = new Map();
  for (const d of domains) if (!stale.has(d.id)) stale.set(d.id, d.staleDays);
  const econ = { ...ECONOMIC_DOMAIN_WEIGHTS, ...(local.economicDomainWeights ?? {}) };
  const { runs, orphanCloses } = ledger ? ledgerRuns(ledger) : { runs: [], orphanCloses: 0 };
  const plan = ledger ? usagePlan(ledger) : null;
  const ctx = { ledgerPresent: Boolean(ledger), costs: plan?.costs ?? [], runs };
  const rows = [];
  const roleRows = [];
  const matched = new Map();
  for (const { key, text } of [...reports].sort((a, b) => a.key.localeCompare(b.key))) {
    const f = reportFacts(key, text, exclusionIds);
    const run = matchRun(f, runs);
    if (run) matched.set(run, key);
    const created = Date.parse(f.created);
    const raw = {
      row_id: sha256(key).slice(0, 12), key, title: f.title, domain: f.domain, kind: f.kind, source: f.source,
      created: f.created, age_days: Number.isNaN(created) ? null : Math.max(0, Math.floor((now - created) / DAY_MS)),
      producer: f.producer ?? (run ? 'gemini-deep-research' : 'unknown'),
      producer_mode: f.mode ?? (run ? 'deep-research' : 'unknown'), producer_model: f.model ?? 'unknown',
      producer_basis: run ? 'usage-ledger' : f.producer ? 'front-matter-classifier' : 'none',
      ...ledgerColumns(run, ctx),
      drive_doc_id: f.driveId, drive_doc_url: f.driveId ? `https://drive.google.com/open?id=${encodeURIComponent(f.driveId)}` : null,
      local_path: `corpus/${key}`, source_urls: f.sourceUrls, source_hosts: f.sourceHosts, evidence: f.evidence, evidence_basis: f.evidenceBasis,
      ...claimColumns(claimSets.get(key), f, text),
    };
    Object.assign(raw, scoreColumns(raw, { staleDays: stale.get(f.domain) ?? DEFAULT_STALE_DAYS, econWeight: econ[f.domain] ?? 0 }));
    const relevance = roleRelevance(f.domain, { title: f.title, headings: headingsOf(f.body) }, local.roleDomains);
    const { row, hits } = redactRow(raw, redact);
    row.privacy = privacyOf(f, hits);
    const [human, agent] = readers(row);
    rows.push(Object.fromEntries(REPORT_COLUMNS.map((c) => [c, row[c] ?? null])));
    roleRows.push({ row_id: row.row_id, key: row.key, title: row.title, domain: row.domain, kind: row.kind,
      evidence: row.evidence, release: row.release, ...relevance, human_reader: human, agent_reader: agent });
  }
  const runRows = runs.map((r) => ({ ...r, title: redact(r.title).text, report: matched.has(r) ? redact(matched.get(r), 'redacted').text : null }));
  const problems = findProblems({ rows, runRows, orphanCloses, claimSets, orphanClaimFiles, econ, ledgerPresent: Boolean(ledger) });
  return { rows, roleRows, runRows, plan, problems, econ };
}

function findProblems({ rows, runRows, orphanCloses, claimSets, orphanClaimFiles, econ, ledgerPresent }) {
  const count = (pred) => rows.filter(pred).length;
  const sets = [...claimSets.values()].filter((s) => !s.backupOnly);
  const checks = [
    [sets.filter((s) => !s.error && !s.manifest).length, 'claims file(s) have no sampling manifest, so the gate blocks them until resampled with `verify sample <key> --force`'],
    [sets.filter((s) => s.error).length, 'claims file(s) could not be read; their reports are blocked'],
    [count((r) => r.release_blocks.some((b) => b.startsWith('scoring failed'))), 'report(s) could not be scored by the claim gate; they are blocked'],
    [count((r) => r.ledger_domain && r.ledger_domain !== r.domain), 'ledger-matched report(s) sit in a different corpus domain than the usage-ledger run recorded'],
    [count((r) => r.cost_basis === 'not-measured'), 'ledger-matched report(s) have no measured cost: another run was open between the readings around it, or a meter reset fell inside'],
    [runRows.filter((r) => r.status === 'open').length, 'usage-ledger run(s) are still open (no done or abandon record)'],
    [orphanCloses, 'usage-ledger done/abandon record(s) name a title that matches no run (a typo leaves the real run open)'],
    [runRows.filter((r) => r.status === 'done' && !r.report).length, 'finished usage-ledger run(s) match no corpus report (not exported yet, or the title changed)'],
    [count((r) => r.evidence_basis === 'computed-by-registry'), 'report(s) lack evidence fields in front matter; the registry computed them from the body'],
    [count((r) => r.privacy === 'exclusion-match'), 'report(s) match a private exclusion pattern once separators are normalized; they may not belong in the corpus'],
    [count((r) => r.privacy === 'excluded-id'), 'report(s) carry an excluded Drive id (quarantine leak)'],
    [count((r) => r.claims_backup === 'differs'), 'claims file(s) differ from their checked backup'],
    [count((r) => r.claims_backup === 'backup-only'), 'checked backup(s) have no primary claims file; the gate reads only the primary, so those reports show as unsampled'],
    [orphanClaimFiles.length, 'claims file(s) name no report in the corpus'],
    [count((r) => r.release !== 'unsampled' && !(econ[r.domain] > 0)), 'sampled report(s) sit in a domain with no economic weight (for example unrouted) and score 0 on economic relevance'],
    [ledgerPresent ? 0 : 1, 'no usage ledger was found; run timing and cost columns are blank'],
  ];
  return checks.filter(([n]) => n > 0).map(([n, text]) => `${n} ${text}.`);
}

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

const cell = (v) => (v === null || v === undefined || v === '' ? '' : String(v).replace(/\|/g, '\\|').replace(/\s+/g, ' '));
const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)];
const presample = (r) => r.score_source_breadth + r.score_freshness + r.score_economic_relevance;

function summaryLines(rows, runRows) {
  const n = (pred) => rows.filter(pred).length;
  return mdTable(['Measure', 'Count'], [
    ['Reports in the corpus', rows.length],
    ['Kind deep-research / gemini-canvas / other', `${n((r) => r.kind === 'deep-research')} / ${n((r) => r.kind === 'gemini-canvas')} / ${n((r) => !['deep-research', 'gemini-canvas'].includes(r.kind))}`],
    ['Evidence cited (at least 10 URLs and 5 hosts)', n((r) => r.evidence === 'cited')],
    ['Claim-sampled', n((r) => r.release !== 'unsampled')],
    ['Release pass / blocked / unsampled', `${n((r) => r.release === 'pass')} / ${n((r) => r.release === 'blocked')} / ${n((r) => r.release === 'unsampled')}`],
    ['Usage-ledger runs / matched to a report / with a measured cost', `${runRows.length} / ${n((r) => r.ledger_run_status)} / ${n((r) => r.cost_basis === 'measured')}`],
    ['Privacy redacted / exclusion-match / excluded-id', `${n((r) => r.privacy === 'redacted')} / ${n((r) => r.privacy === 'exclusion-match')} / ${n((r) => r.privacy === 'excluded-id')}`],
  ]);
}

function weightLines(econ, localKeys) {
  const domainList = Object.entries(econ).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([d, w]) => `${d} ${w}${localKeys.has(d) ? ' (local)' : ''}`).join(' · ');
  return [
    ...mdTable(['Component', 'Max', 'Rule'], [
      ['Evidence integrity', WEIGHTS.evidenceIntegrity, `verified ÷ checked × min(1, checked ÷ min(${SAMPLE_FOR_FULL_CREDIT}, claims in report)); blank when unsampled. Claims in report = every claim in any extraction mode (table and cited prose)`],
      ['Source breadth', WEIGHTS.sourceBreadth, `min(1, distinct cited hosts ÷ ${HOSTS_FOR_FULL_CREDIT})`],
      ['Freshness', WEIGHTS.freshness, `full inside the domain's refresh window (staleDays, default ${DEFAULT_STALE_DAYS}), then linear to 0 over ${FRESHNESS_DECAY_WINDOWS} more windows`],
      ['Verification coverage', WEIGHTS.verificationCoverage, 'min(1, checked claims ÷ claims in report across all extraction modes); blank when unsampled'],
      ['Economic relevance', WEIGHTS.economicRelevance, 'domain weight × max; set only by the table below, never by keywords'],
    ]),
    '', `Economic domain weights: ${domainList}. Unlisted domains weigh 0.`,
  ];
}

function ledgerLines(runRows, plan, ledgerPresent) {
  if (!ledgerPresent) return ['No usage ledger was found, so run timing and cost columns are blank.'];
  const mean = (x) => (x === null || x === undefined ? 'n/a' : `${+x.toFixed(1)}%`);
  return [
    `Measured runs: ${plan.measuredRuns}. Mean cost per measured run: window ${mean(plan.sessionPerRun)}, weekly ${mean(plan.weeklyPerRun)}. A run is measured only when it is the only run between the readings around it and no meter reset falls inside (rules: README, "Gemini usage").`, '',
    ...mdTable(['Run title', 'Ledger domain', 'Status', 'Started', 'Finished', 'Matched report'],
      runRows.map((r) => [r.title, r.domain, r.status, r.started, r.finished ?? '', r.report ?? ''])),
  ];
}

export function registryMarkdown({ rows, runRows, plan, problems, econ, localKeys = new Set(), builtAt, redaction, ledgerPresent, roleRows }) {
  const ranked = rows.filter((r) => r.release !== 'unsampled').sort((a, b) => b.rank_score - a.rank_score || a.key.localeCompare(b.key));
  const queue = rows.filter((r) => r.release === 'unsampled' && r.evidence === 'cited').sort((a, b) => presample(b) - presample(a) || a.key.localeCompare(b.key));
  const roleCounts = Object.keys(ROLES).map((role) => [role, roleRows.filter((r) => r[role] >= 2).length, roleRows.filter((r) => r[role] === 3).length]);
  const byRelease = { pass: 0, blocked: 1, unsampled: 2 };
  const all = [...rows].sort((a, b) => byRelease[a.release] - byRelease[b.release] || a.key.localeCompare(b.key));
  return [
    '# Research registry', '',
    '> **Weights are hypotheses.** The rank score only orders what to review next; it never releases a report. Release comes only from the claim gate (`node corpus.mjs verify score <key>`): `pass` or `blocked`. A report with no claim records is `unsampled`, and its rank is `unranked`.', '',
    `Built ${builtAt} from ${rows.length} corpus reports. Paths are relative to RESEARCH_HOME. reports.csv and reports.jsonl hold every column; roles.csv holds the role relevance matrix; all three share \`row_id\`.`, '',
    redaction, '',
    '## Summary', '', ...summaryLines(rows, runRows), '',
    '## Weights (hypotheses)', '', ...weightLines(econ, localKeys), '',
    '## Ranked: claim-sampled reports', '',
    ...mdTable(['Rank', 'Key', 'Domain', 'Release', 'Verified / checked / in report', 'Integrity', 'Breadth', 'Fresh', 'Coverage', 'Econ', 'Blocks'],
      ranked.map((r) => [r.rank_score, r.key, r.domain, r.release, `${r.claims_verified ?? 0} / ${r.claims_checked ?? 0} / ${r.claims_in_report ?? '?'}`,
        r.score_evidence_integrity, r.score_source_breadth, r.score_freshness, r.score_verification_coverage, r.score_economic_relevance, r.release_blocks.length])), '',
    '## Next to sample: unsampled reports with cited evidence', '',
    'Ordered by the three sub-scores that need no claim checks (breadth, freshness, economic relevance). This is a sampling queue, not a rank.', '',
    ...mdTable(['Key', 'Domain', 'Kind', 'Hosts', 'Breadth', 'Fresh', 'Econ'],
      queue.map((r) => [r.key, r.domain, r.kind, r.source_hosts, r.score_source_breadth, r.score_freshness, r.score_economic_relevance])), '',
    '## Gemini usage ledger', '', ...ledgerLines(runRows, plan, ledgerPresent), '',
    '## Problems found', '', ...(problems.length ? problems.map((p) => `- ${p}`) : ['- None.']), '',
    '## Roles: reports at relevance 2 or more', '', ...mdTable(['Role', 'Relevance ≥ 2', 'Relevance 3'], roleCounts), '',
    '## All reports', '',
    ...mdTable(['Key', 'Kind', 'Domain', 'Evidence', 'Release', 'Rank'], all.map((r) => [r.key, r.kind, r.domain, r.evidence, r.release, r.rank_score])), '',
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
  const reports = listMarkdown(corpusDir).map((file) => ({
    key: path.relative(corpusDir, file).split(path.sep).join('/'), text: readFileSync(file, 'utf8'),
  }));
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
  return {
    reports, claimSets, orphanClaimFiles,
    ledger: existsSync(usage) ? readJsonl(usage) : null,
    domains: [...readJson(path.join(home, 'domains.local.json'), { domains: [] }).domains, ...readJson(path.join(HERE, 'domains.json'), { domains: [] }).domains],
    local: readJson(path.join(home, 'registry', 'weights.local.json'), {}),
    exclusionIds: new Set(readLines(path.join(home, 'exclude-ids.txt'))),
    exclusionPhrases: readLines(path.join(home, 'exclude.txt')),
    denylist: existsSync(redactFile) ? parseRedactList(readFileSync(redactFile, 'utf8')) : null,
    redactFile,
  };
}

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function runBuild({ home, allowUnredacted = false, now = Date.now() }) {
  const input = loadHome(home);
  if (!input.denylist && !allowUnredacted) {
    throw new Error(`no redaction list at ${input.redactFile}: outputs could name people. Add hashes with "node registry.mjs redact-hash", or pass --allow-unredacted`);
  }
  const redact = makeRedactor({ entries: input.denylist ?? [], phrases: input.exclusionPhrases });
  const reg = buildRegistry({ ...input, redact, now });
  const redaction = input.denylist
    ? `Share-check: every output was scanned against ${input.denylist.length} hashed name phrase(s) and ${input.exclusionPhrases.length} private exclusion pattern(s) before writing; a hit stops the build and writes nothing. Matches are shown as [redacted].`
    : '**Not checked for personal names:** built with --allow-unredacted and no redaction list. Do not share.';
  const files = {
    'reports.csv': toCsv(reg.rows, REPORT_COLUMNS),
    'reports.jsonl': `${reg.rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
    'roles.csv': toCsv(reg.roleRows, ROLE_COLUMNS),
    'REGISTRY.md': registryMarkdown({ ...reg, builtAt: new Date(now).toISOString(), redaction, ledgerPresent: Boolean(input.ledger),
      localKeys: new Set(Object.keys(input.local.economicDomainWeights ?? {})) }),
  };
  const leaks = Object.entries(files).filter(([, text]) => redact(text).hits.size).map(([name]) => name);
  if (leaks.length) throw new Error(`share-check failed: ${leaks.join(', ')} still match the redaction list; nothing was written`);
  const dir = path.join(home, 'registry');
  for (const [name, text] of Object.entries(files)) writeAtomic(path.join(dir, name), text);
  return { dir, files: Object.keys(files), reports: reg.rows.length, problems: reg.problems };
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
    console.log(JSON.stringify({ dir: out.dir, files: out.files, reports: out.reports, problems: out.problems.length }, null, 2));
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
