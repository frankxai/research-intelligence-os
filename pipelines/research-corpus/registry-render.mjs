// Research registry: rendering. CSV with spreadsheet-formula protection, the private REGISTRY.md and the shareable
// snapshot.

import {
  DEFAULT_STALE_DAYS, FRESHNESS_DECAY_WINDOWS, HOSTS_FOR_FULL_CREDIT, ROLES, SAMPLE_FOR_FULL_CREDIT, TEXT, WEIGHTS,
} from './registry-schema.mjs';

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

export const fmt = (template, values) => template.replace(/\{(\w+)\}/g, (_, k) => String(values[k]));
const cell = (v) => (v === null || v === undefined || v === '' ? '' : String(v).replace(/\|/g, '\\|').replace(/\s+/g, ' '));
const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)];
const presample = (r) => r.score_source_breadth + r.score_freshness + r.score_economic_relevance;
const H = TEXT.head;

function summaryLines(rows, runRows, withheld) {
  const n = (pred) => rows.filter(pred).length;
  const S = TEXT.summary;
  return mdTable([H.measure, H.count], [
    [S.reports, rows.length],
    [S.kinds, `${n((r) => r.kind === 'deep-research')} / ${n((r) => r.kind === 'gemini-canvas')} / ${n((r) => !['deep-research', 'gemini-canvas'].includes(r.kind))}`],
    [S.cited, n((r) => r.evidence === 'cited')],
    [S.sampled, n((r) => r.release !== 'unsampled')],
    [S.release, `${n((r) => r.release === 'pass')} / ${n((r) => r.release === 'blocked')} / ${n((r) => r.release === 'unsampled')}`],
    [S.ledger, `${runRows.length} / ${n((r) => r.ledger_run_status)} / ${n((r) => r.cost_basis === 'measured')}`],
    [S.withheld, withheld],
    [S.redacted, n((r) => r.privacy === 'redacted')],
  ]);
}

// The scoring components and rules: public code constants, shown in both tiers.
function weightTable() {
  const C = TEXT.component;
  const R = TEXT.rule;
  return mdTable([H.component, H.max, H.rule], [
    [C.integrity, WEIGHTS.evidenceIntegrity, fmt(R.integrity, { s: SAMPLE_FOR_FULL_CREDIT })],
    [C.breadth, WEIGHTS.sourceBreadth, fmt(R.breadth, { h: HOSTS_FOR_FULL_CREDIT })],
    [C.freshness, WEIGHTS.freshness, fmt(R.freshness, { d: DEFAULT_STALE_DAYS, w: FRESHNESS_DECAY_WINDOWS })],
    [C.coverage, WEIGHTS.verificationCoverage, R.coverage],
    [C.economic, WEIGHTS.economicRelevance, R.economic],
  ]);
}

function econLine(econ, localKeys) {
  const list = Object.entries(econ).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([d, w]) => `${d} ${w}${localKeys.has(d) ? ` ${TEXT.local}` : ''}`).join('; ');
  return fmt(TEXT.econ, { list });
}

function ledgerLines(runRows, plan, ledgerPresent) {
  if (!ledgerPresent) return [TEXT.noLedger];
  const mean = (x) => (x === null || x === undefined ? TEXT.na : `${+x.toFixed(1)}%`);
  return [
    fmt(TEXT.measured, { n: plan.measuredRuns, s: mean(plan.sessionPerRun), w: mean(plan.weeklyPerRun) }), '',
    ...mdTable([H.runTitle, H.ledgerDomain, H.status, H.started, H.finished, H.matched],
      runRows.map((r) => [r.title, r.domain, r.status, r.started, r.finished ?? '', r.report ?? ''])),
  ];
}

// The private tier: one row per report, named by corpus key, with exact scores and full ledger links.
export function privateMarkdown({ rows, roleRows, runRows, plan, problems, econ, localKeys = new Set(), builtAt, withheld, nameCheck, ledgerPresent }) {
  const byKey = (a, b) => a.key.localeCompare(b.key);
  const ranked = rows.filter((r) => r.release !== 'unsampled').sort((a, b) => b.rank_score - a.rank_score || byKey(a, b));
  const queue = rows.filter((r) => r.release === 'unsampled' && r.evidence === 'cited').sort((a, b) => presample(b) - presample(a) || byKey(a, b));
  const roleCounts = Object.keys(ROLES).map((role) => [role, roleRows.filter((r) => r[role] >= 2).length, roleRows.filter((r) => r[role] === 3).length]);
  const order = { pass: 0, blocked: 1, unsampled: 2 };
  const all = [...rows].sort((a, b) => (order[a.release] ?? 3) - (order[b.release] ?? 3) || byKey(a, b));
  return [
    TEXT.headPrivate, '', TEXT.notePrivate, '', TEXT.hypotheses, '',
    `${fmt(TEXT.built, { at: builtAt, n: rows.length, w: withheld })} ${TEXT.paths}`, '',
    nameCheck, '',
    TEXT.hSummary, '', ...summaryLines(rows, runRows, withheld), '',
    TEXT.hWeights, '', ...weightTable(), '', econLine(econ, localKeys), '', TEXT.bandNote, '',
    TEXT.hRanked, '',
    ...mdTable([H.rank, H.band, H.report, H.domain, H.release, H.vci, H.share, H.integrity, H.breadth, H.fresh, H.coverage, H.econ, H.blocks],
      ranked.map((r) => [r.rank_score, r.score_band, r.key, r.domain, r.release, `${r.claims_verified ?? 0} / ${r.claims_checked ?? 0} / ${r.claims_in_report ?? TEXT.na}`,
        r.sampled_share, r.score_evidence_integrity, r.score_source_breadth, r.score_freshness, r.score_verification_coverage, r.score_economic_relevance,
        r.release_block_count])), '',
    TEXT.hQueue, '', TEXT.queueNote, '',
    ...mdTable([H.report, H.domain, H.kind, H.hosts, H.breadth, H.fresh, H.econ],
      queue.map((r) => [r.key, r.domain, r.kind, r.source_hosts, r.score_source_breadth, r.score_freshness, r.score_economic_relevance])), '',
    TEXT.hLedger, '', ...ledgerLines(runRows, plan, ledgerPresent), '',
    TEXT.hProblems, '', ...(problems.length ? problems.map((p) => `- ${p}`) : [TEXT.none]), '',
    TEXT.hRoles, '', ...mdTable([H.role, H.rel2, H.rel3], roleCounts), '',
    TEXT.hAll, '',
    ...mdTable([H.report, H.kind, H.domain, H.evidence, H.release, H.rank], all.map((r) => [r.key, r.kind, r.domain, r.evidence, r.release, r.rank_score])), '',
  ].join('\n');
}

// The shareable tier: one file, built from the coarse snapshot alone.
export function shareableMarkdown(snap, { builtDay }) {
  const S = TEXT.share;
  const tables = (list, head) => list.flatMap((d) => [`### ${S.dims[d.id]}`, '', ...mdTable([S.head.bucket, head], d.cells), '']);
  return [
    S.title, '', S.note, '', S.method, '', S.hLimits, '', S.limits, '', fmt(S.built, { day: builtDay }), '',
    S.withheld, '', S.release, '', TEXT.checkedShare, '',
    S.hCorpus, '', fmt(S.total, { n: snap.total }), '',
    S.hCounts, '', ...tables(snap.counts, S.head.reports),
    S.hCost, '', snap.cost, '',
    S.diagnostics, '',
  ].join('\n');
}
