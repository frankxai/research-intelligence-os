// Research registry: the fixed vocabulary both tiers are built from. Weights and role rules, the private columns, the
// public schema of the shareable tier (public domain ids, enums, bands), reader guidance, and every sentence either
// tier prints. Nothing here comes from private configuration or the corpus.

import { MIN_VERIFIED_RATE } from './lib.mjs';

// ---------------------------------------------------------------------------------------------
// Weights. Hypotheses, not calibrated values: they order the review queue and never release a report.
export const WEIGHTS = { evidenceIntegrity: 40, sourceBreadth: 15, freshness: 15, verificationCoverage: 15, economicRelevance: 15 };
// Full sample-size credit once this many claims are checked (or every claim, for a shorter report).
export const SAMPLE_FOR_FULL_CREDIT = 10;
// Full breadth credit at this many distinct cited hosts; linear below it.
export const HOSTS_FOR_FULL_CREDIT = 25;
// Full freshness inside the domain's refresh window (staleDays), then linear to zero over this many more windows.
export const FRESHNESS_DECAY_WINDOWS = 2;
export const DEFAULT_STALE_DAYS = 30;

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
// Private columns: one row per report, with titles, keys, paths, Drive links, exact scores and ledger links.
export const PRIVATE_COLUMNS = [
  'row_id', 'key', 'title', 'domain', 'kind', 'source', 'created', 'age_days',
  'producer', 'producer_mode', 'producer_model', 'producer_basis', 'prompt_sha256', 'prompt_bytes',
  'run_started', 'run_finished', 'ledger_run_status', 'ledger_domain', 'cost_basis', 'window_pct_cost', 'weekly_pct_cost',
  'drive_doc_id', 'drive_doc_url', 'local_path', 'source_urls', 'source_hosts', 'evidence', 'evidence_basis',
  'claims_in_report', 'claims_sampled', 'sampled_share', 'claims_checked', 'claims_verified', 'claims_partial', 'claims_contradicted',
  'claims_unsupported', 'claims_garbled', 'claims_unreachable', 'claims_pending', 'verified_rate', 'supported_rate',
  'release', 'release_block_count', 'release_blocks', 'checker', 'checked_at', 'claims_backup', 'privacy',
  'score_evidence_integrity', 'score_source_breadth', 'score_freshness', 'score_verification_coverage', 'score_economic_relevance', 'rank_score',
  'score_band', 'verified_rate_band', 'sampled_share_band',
];
export const PRIVATE_ROLE_COLUMNS = ['row_id', 'key', 'title', 'domain', 'kind', 'evidence', 'release', ...Object.keys(ROLES), 'human_reader', 'agent_reader'];

// ---------------------------------------------------------------------------------------------
// The public schema of the shareable tier, defined here and nowhere else: private configuration (domains.local.json,
// weights.local.json) can never add a word, a bucket or a weight to it. Domain ids mirror the public domains.json (a
// test keeps the two in step); any other id, including every private one, is counted under 'other'.
export const PUBLIC_DOMAIN_IDS = Object.freeze([
  'agentic-income-streams', 'ai-models-platforms', 'github-ecosystem', 'digital-product-design', 'web-design', 'marketing',
  'community', 'solana', 'ethereum', 'bitcoin', 'web3-general', 'publishing-books', 'music-media', 'human-potential',
  'business-strategy', 'unrouted',
]);
export const PUBLIC_DOMAINS = new Set(PUBLIC_DOMAIN_IDS.filter((d) => /^[a-z0-9-]+$/.test(d)));
export const OTHER = 'other';
export const ENUMS = {
  kind: ['deep-research', 'gemini-canvas', 'estate-doc', 'platform-catalog', 'unknown'],
  evidence: ['cited', 'uncited'],
  release: ['pass', 'blocked', 'unsampled'],
};
// Every bucket a banded dimension can take, fixed in advance so the set of buckets never depends on the data.
export const BANDS = {
  verified_rate: ['under 50%', '50-69%', '70% or more', 'not checked'],
  sampled_share: ['under 10%', '10-24%', '25-49%', '50% or more', 'unsampled'],
  age: ['0-7 days', '8-30 days', '31-90 days', '91-365 days', 'over 365 days', 'unknown'],
  score: ['A', 'B', 'C', 'unranked'],
  window: ['under 25%', '25-49%', '50-74%', '75% or more'],
  weekly: ['under 2%', '2-4%', '5-9%', '10% or more'],
};

// How a person and an agent should consume a report, by what has been checked, not by topic. A pass licenses
// citing only the sampled claims a checker verified, never the report as a whole: a partial claim carries details
// its source does not state, and the rest of the report was never checked.
const READERS = {
  pass: ['Cite only the sampled claims marked verified, as of their check date; partial claims and the rest of the report are unverified AI synthesis.', 'Use only verified claim records, each with its source and date; treat partial claims and everything else in the report as unverified.'],
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

// Every word REGISTRY.md may contain in either tier, beyond values, numbers and dates. ASCII only.
export const TEXT = {
  headPrivate: '# Research registry: PRIVATE tier',
  notePrivate: '> **Private: do not share.** This tier holds titles, corpus keys, file paths, Drive links, exact scores and ledger links. `row_id` is the first 12 hex digits of the SHA-256 of the corpus key, so anyone who guesses a key can confirm it: the id is as private as the key. Names are redacted against the private name list on a best-effort basis only: look-alike letters from another script, and a name glued to the next word by an invisible character, are not caught. Share `registry/shareable/` instead.',
  hypotheses: '> **Weights are hypotheses.** Scores and score bands only order what to review next; they never release a report. Release comes only from the claim gate (`node corpus.mjs verify score <key>`): `pass` or `blocked`. '
    + `A pass needs at least ${Math.round(MIN_VERIFIED_RATE * 100)}% of checked claims verified, and it licenses citing only the sampled claims a checker verified, never the report as a whole. `
    + 'A report with no claim records is `unsampled`, and its rank is `unranked`.',
  built: 'Built {at} from {n} corpus reports; {w} excluded, withheld (excluded by Drive id, quarantine or the pipeline exclusion rules: no row, ledger run, cost or claim diagnostic in either tier). reports.csv and reports.jsonl hold every column of this tier; roles.csv holds the role relevance matrix per report; all three share `row_id`.',
  paths: 'Paths are relative to RESEARCH_HOME.',
  checkedPrivate: 'Name check: every private output was scanned against {d} hashed name phrase(s) and {p} private exclusion pattern(s) before writing; a hit stops the build. Matches show as [redacted].',
  uncheckedPrivate: '**Not checked for personal names:** built with --allow-unredacted and no redaction list.',
  checkedShare: 'Structure check: printable ASCII only, and no word the registry does not define.',
  hSummary: '## Summary', hWeights: '## Weights (hypotheses)', hRanked: '## Ranked: claim-sampled reports',
  hQueue: '## Next to sample: unsampled reports with cited evidence',
  queueNote: 'Ordered by the three sub-scores that need no claim checks (breadth, freshness, economic relevance). This is a sampling queue, not a rank.',
  hLedger: '## Gemini usage ledger', hProblems: '## Problems found', hRoles: '## Roles: reports at relevance 2 or more', hAll: '## All reports',
  none: '- None.', na: 'n/a', local: '(local)',
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
    started: 'Started', finished: 'Finished', matched: 'Matched report', band: 'Band',
  },
  component: { integrity: 'Evidence integrity', breadth: 'Source breadth', freshness: 'Freshness', coverage: 'Verification coverage', economic: 'Economic relevance' },
  rule: {
    integrity: 'verified / checked * min(1, checked / min({s}, claims in report)); blank when unsampled. Claims in report = every claim in any extraction mode (table and cited prose)',
    breadth: 'min(1, distinct cited hosts / {h})',
    freshness: 'full inside the domain refresh window (staleDays, default {d}), then linear to 0 over {w} more windows',
    coverage: 'min(1, checked claims / claims in report across all extraction modes); blank when unsampled',
    economic: 'domain weight * max; the per-domain weights are configuration, never keywords',
  },
  bandNote: 'Score band (both tiers): computed from the public weights in registry.mjs only, never from private configuration: A 70-100, B 40-69, C 0-39; `unranked` means no claim records.',
  share: {
    title: '# Research registry: shareable snapshot',
    note: '> **Shareable, coarse by design.** This file holds the corpus total and one-dimension counts, each rounded to the nearest 10 (under 10 shows as `<10`). It holds no per-report row or id, no title, file path, corpus key, Drive id or link, no score, no release verdict or claim-check result, no cross-tabulation and no text from a report or the usage ledger. Before writing, every character was checked to be printable ASCII and every word to be defined by the registry; anything else stops the build.',
    method: 'Method: the figures are coarse on purpose, because exact or cross-tabulated counts let a reader recover individual reports by subtraction. The private tier (`registry/private/`) is the owner\'s source of truth and is never shared.',
    hLimits: '## Known limits of the shareable tier',
    limits: 'The figures are rounded to 10, so two snapshots shared with the same recipient can still be compared across a rounding boundary (for example 9->10, 14->15 or 24->25) by someone who knows exactly which report changed between them, and that comparison can reveal the report\'s domain, kind, evidence label or age band. Share ONE snapshot with a recipient and do not refresh it for the same recipient. Treat the private tier as the owner\'s source of truth, and never share per-report data.',
    built: 'Built {day}.',
    withheld: 'Documents excluded by Drive id, quarantine or the pipeline exclusion rules, if any, are withheld from every figure in this file, together with their usage-ledger runs and costs; their number is not stated.',
    release: 'Release verdicts, claim-check results and score bands are in the private tier.',
    hCorpus: '## Corpus', total: 'Reports: {n} (rounded to the nearest 10; under 10 shows as <10).',
    hCounts: '## Reports by one dimension (each count rounded to the nearest 10; under 10 shows as <10)',
    dims: {
      domain: 'Domain id (public ids; every other id counts as other)', kind: 'Kind', evidence: 'Evidence label (cited: at least 10 URLs and 5 hosts)',
      age: 'Age band (days since the report was created)',
    },
    hCost: '## Usage cost',
    cost: 'Mean cost per measured Deep Research run over the whole usage ledger: window {s}, weekly {w}. Bands only; never per run.',
    costInsufficient: 'Insufficient data: fewer than 10 measured runs. No per-run times or costs are published.',
    noLedger: 'No usage ledger.',
    diagnostics: 'Role relevance and pipeline diagnostics are in the private tier.',
    head: { bucket: 'Bucket', reports: 'Reports' },
  },
};

// Pipeline diagnostics: private tier only.
export const PROBLEMS = {
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
