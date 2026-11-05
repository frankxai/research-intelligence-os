// Research registry: facts per report and per run. Front matter, usage-ledger runs and how they match reports, the
// runs an excluded document withholds, claim tallies from the release gate, scores and role relevance.

import { evidenceStats, extractClaims, normalizeEol, scoreClaims, usagePlan } from './lib.mjs';
import { phraseOf } from './registry-privacy.mjs';
import { FRESHNESS_DECAY_WINDOWS, HOSTS_FOR_FULL_CREDIT, ROLES, SAMPLE_FOR_FULL_CREDIT, WEIGHTS } from './registry-schema.mjs';

const HOUR_MS = 3_600_000;

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
      .map((r) => ({ type: r.type, ts: r.at ?? r.ts, docId: r.doc_id ?? null }))
      .filter((e) => e.ts >= run.ts && (!next || e.ts <= next.ts))
      .sort((a, b) => a.ts.localeCompare(b.ts))[0] ?? null;
    const status = !end ? 'open' : end.type === 'done' ? 'done' : 'abandoned';
    // Recorded by `usage run --model --mode --prompt-file` and `usage done --doc-id`; older rows have none of them. The
    // doc id is kept from whichever record closed the run, so an excluded id also withholds an abandoned run.
    // matchRun links a report by doc id only to a run that is done.
    const details = { model: run.model ?? null, mode: run.mode ?? null, promptSha256: run.prompt_sha256 ?? null, promptBytes: run.prompt_bytes ?? null,
      docId: end?.docId ?? null };
    return { title: run.title, domain: run.domain ?? null, started: run.ts, finished: status === 'done' ? end.ts : null, status, ...details };
  });
  const titles = new Set(runs.map((r) => r.title));
  const orphanCloseRecords = rows.filter((r) => (r.type === 'done' || r.type === 'abandoned') && !titles.has(r.title))
    .map((r) => ({ title: r.title, docId: r.doc_id ?? null }));
  return { runs, orphanCloses: orphanCloseRecords.length, orphanCloseTitles: orphanCloseRecords.map((r) => r.title), orphanCloseRecords };
}

// A report is exported up to this long after its run is marked done.
const RUN_MATCH_GRACE_MS = 2 * HOUR_MS;
const OPEN_RUN_SPAN_MS = 6 * HOUR_MS;
const MIN_TITLE_WORDS = 3;

// One title contains the other as whole words, and the report title is long enough to mean something.
export function titlesOverlap(reportTitle, runTitle) {
  const t = phraseOf(reportTitle);
  const r = phraseOf(runTitle);
  return t.split(' ').length >= MIN_TITLE_WORDS && (` ${r} `.includes(` ${t} `) || ` ${t} `.includes(` ${r} `));
}

// The same normalized title, at any length: an excluded report claims every ledger run and close record so titled,
// however short its title is.
export function sameTitle(a, b) {
  const x = phraseOf(a);
  return x !== '' && x === phraseOf(b);
}

// The report was created between the run's start and its end (or the open-run span) plus the grace.
function inRunWindow(created, run) {
  const start = Date.parse(run.started);
  const end = run.finished ? Date.parse(run.finished) : start + OPEN_RUN_SPAN_MS;
  return created >= start && created <= end + RUN_MATCH_GRACE_MS;
}

// A run matches a report when their titles overlap and the report was created in the run's window. An abandoned
// run produced no report by definition.
// A run closed with a Drive doc id (`usage done --doc-id`) is matched by that id first, and is never matched by title
// to a report with a different Drive id.
export function matchRun(report, runs) {
  const byDoc = report.driveId ? runs.find((run) => run.status === 'done' && run.docId === report.driveId) : null;
  if (byDoc) return byDoc;
  const created = Date.parse(report.created);
  if (Number.isNaN(created)) return null;
  const otherDoc = (run) => Boolean(run.docId && report.driveId && run.docId !== report.driveId);
  const hits = runs.filter((run) => run.status !== 'abandoned' && !otherDoc(run) && titlesOverlap(report.title, run.title) && inRunWindow(created, run));
  const endOf = (run) => Date.parse(run.finished ?? run.started);
  return hits.sort((a, b) => Math.abs(created - endOf(a)) - Math.abs(created - endOf(b)))[0] ?? null;
}

// Runs that belong to excluded reports (including quarantined documents no longer in corpus/), in any status: every run
// with the same normalized title at any length, every run whose title overlaps an excluded report's, every run closed
// with its Drive id, and every run in its domain whose window holds its creation time unless that run's title matches
// a kept report. They are dropped before any ledger table, count, cost band or aggregate is computed. `excludedIds` is
// the excluded Drive id set itself (exclude-ids.txt plus the ids of excluded and quarantined documents): a run closed
// with one of them is dropped even when no local copy of that document exists anywhere.
export function excludedRuns(runs, excluded, kept, excludedIds = new Set()) {
  const keptRuns = new Set(kept.map((f) => matchRun(f, runs)).filter(Boolean));
  const dropped = new Set(runs.filter((run) => run.docId && excludedIds.has(run.docId)));
  for (const f of excluded) {
    const created = Date.parse(f.created);
    for (const run of runs) {
      const byTitle = sameTitle(f.title, run.title) || titlesOverlap(f.title, run.title);
      const byDoc = Boolean(f.driveId && run.docId === f.driveId);
      const byDomainTime = !keptRuns.has(run) && run.domain === f.domain && !Number.isNaN(created) && inRunWindow(created, run);
      if (byTitle || byDoc || byDomainTime) dropped.add(run);
    }
  }
  return dropped;
}

// The usage plan over the kept runs only. Costs are measured on the whole ledger, so an excluded run still makes an
// overlapping kept run unmeasurable rather than inflating its cost; the excluded runs' own costs are then dropped.
export function keptPlan(ledger, dropped) {
  const full = usagePlan(ledger);
  const isDropped = (c) => [...dropped].some((r) => r.title === c.title && r.domain === (c.domain ?? null));
  const costs = full.costs.filter((c) => !isDropped(c));
  const mean = (k) => (costs.length ? costs.reduce((s, c) => s + c[k], 0) / costs.length : null);
  return { measuredRuns: costs.length, costs, sessionPerRun: mean('session'), weeklyPerRun: mean('weekly') };
}

// Line endings are normalized first, as the verifier does, so a file saved with CRLF or lone CR keeps its
// source, Drive id and exclusion status.
export function reportFacts(key, text, exclusionIds) {
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

export function ledgerColumns(run, { ledgerPresent, costs, runs }) {
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
export function claimColumns(set, facts, text) {
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
    // Rates from whole counts, shown to four decimals: the gate's own three-decimal rounding can cross a band boundary
    // (1399 of 2000 would show as 0.7). Bands are classified from the counts themselves (verifiedRateBand).
    verified_rate: score.checked ? +(s.verified / score.checked).toFixed(4) : null,
    supported_rate: score.checked ? +((s.verified + s.partial) / score.checked).toFixed(4) : null,
    release: score.release, release_blocks: score.blocks,
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
  const verifiedShare = checked ? (row.claims_verified ?? 0) / checked : 0;
  const integrity = WEIGHTS.evidenceIntegrity * verifiedShare * sampleCredit;
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

export function headingsOf(body) {
  return [...body.matchAll(/^#{1,3}\s+(.+)$/gm)].slice(0, 60).map((m) => m[1]).join(' \n ');
}
