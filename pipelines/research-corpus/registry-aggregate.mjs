// Research registry: the coarse snapshot behind the shareable tier. Rounded one-dimension counts, bands from whole
// counts, the public score band, the usage-cost band, and the vocabulary check every shareable file must pass.

import {
  BANDS, DEFAULT_STALE_DAYS, ECONOMIC_DOMAIN_WEIGHTS, ENUMS, OTHER, PUBLIC_DOMAIN_IDS, PUBLIC_DOMAINS, TEXT,
} from './registry-schema.mjs';
import { scoreColumns } from './registry-facts.mjs';
import { fmt } from './registry-render.mjs';

// ---------------------------------------------------------------------------------------------
// Shareable tier: one coarse snapshot. Cell suppression cannot stop subtraction across tables, files and successive
// snapshots, so the shareable tier publishes no cross-tabulation at all: the corpus total and one-dimension counts,
// each rounded to the nearest 10 (anything under 10, zero included, shows as '<10'). Nothing that depends on which
// reports were claim-checked (release verdicts, verified-rate, sampled-share and score bands) is published, not even
// whether a bucket is empty: a none -> some change between two snapshots names the one report checked in between.
// Nothing per report, per run or from private configuration is written.
const enumOf = (field, v) => (ENUMS[field].includes(v) ? v : OTHER);
const domainOf = (v) => (PUBLIC_DOMAINS.has(v) ? v : OTHER);
const ROUND_TO = 10;
export const coarseCount = (n) => (n < ROUND_TO ? `<${ROUND_TO}` : String(Math.round(n / ROUND_TO) * ROUND_TO));

const B = BANDS;
// Bands come from whole counts, never from a rounded ratio, so 1399 verified of 2000 checked (69.95%) is under 70%
// and 2499 sampled of 10000 (24.99%) is under 25%, as the release gate itself counts them.
export function verifiedRateBand(r) {
  const checked = r.claims_checked ?? 0;
  if (r.release === 'unsampled' || !checked) return B.verified_rate[3];
  const verified = (r.claims_verified ?? 0) * 100;
  return verified >= 70 * checked ? B.verified_rate[2] : verified >= 50 * checked ? B.verified_rate[1] : B.verified_rate[0];
}

export function sampledShareBand(r) {
  const inReport = r.claims_in_report ?? 0;
  if (r.release === 'unsampled' || !inReport || typeof r.claims_sampled !== 'number') return B.sampled_share[4];
  const sampled = r.claims_sampled * 100;
  return sampled < 10 * inReport ? B.sampled_share[0] : sampled < 25 * inReport ? B.sampled_share[1]
    : sampled < 50 * inReport ? B.sampled_share[2] : B.sampled_share[3];
}

const ageBand = (r) => (typeof r.age_days !== 'number' ? B.age[5]
  : r.age_days <= 7 ? B.age[0] : r.age_days <= 30 ? B.age[1] : r.age_days <= 90 ? B.age[2] : r.age_days <= 365 ? B.age[3] : B.age[4]);
const windowBand = (x) => (x < 25 ? B.window[0] : x < 50 ? B.window[1] : x < 75 ? B.window[2] : B.window[3]);
const weeklyBand = (x) => (x < 2 ? B.weekly[0] : x < 5 ? B.weekly[1] : x < 10 ? B.weekly[2] : B.weekly[3]);

// The score band uses public inputs only: the public economic weights in this file, and the refresh windows of the
// public domains.json. A private domain id scores as unlisted; private weights and role bases never enter.
export function publicScoreBand(row, publicStale = new Map()) {
  if (row.release === 'unsampled') return B.score[3];
  const domain = PUBLIC_DOMAINS.has(row.domain) ? row.domain : null;
  const staleDays = (domain && publicStale.get(domain)) || DEFAULT_STALE_DAYS;
  const { rank_score: score } = scoreColumns(row, { staleDays, econWeight: domain ? ECONOMIC_DOMAIN_WEIGHTS[domain] ?? 0 : 0 });
  return score >= 70 ? B.score[0] : score >= 40 ? B.score[1] : B.score[2];
}

// One-dimension counts, rounded; never combined with each other.
const COUNTED = [
  { id: 'domain', buckets: [...PUBLIC_DOMAIN_IDS, OTHER], of: (r) => domainOf(r.domain) },
  { id: 'kind', buckets: [...ENUMS.kind, OTHER], of: (r) => enumOf('kind', r.kind) },
  { id: 'evidence', buckets: [...ENUMS.evidence, OTHER], of: (r) => enumOf('evidence', r.evidence) },
  { id: 'age', buckets: B.age, of: ageBand },
];

// Usage cost for the shareable tier: a band of the mean over the kept measured runs, and only over at least ten, so a
// recipient who knows the cost of most runs learns little about the one they do not know.
const MIN_RUNS_FOR_COST = 10;
function costLine(plan, ledgerPresent) {
  if (!ledgerPresent) return TEXT.share.noLedger;
  if (!plan || plan.measuredRuns < MIN_RUNS_FOR_COST) return TEXT.share.costInsufficient;
  return fmt(TEXT.share.cost, { s: windowBand(plan.sessionPerRun), w: weeklyBand(plan.weeklyPerRun) });
}

// The coarse snapshot: everything the shareable tier publishes, from the kept report rows and the kept-run plan.
export function coarseSnapshot(rows, { plan = null, ledgerPresent = false } = {}) {
  const count = (pred) => rows.filter(pred).length;
  return {
    total: coarseCount(rows.length),
    counts: COUNTED.map((d) => ({ id: d.id, cells: d.buckets.map((b) => [b, coarseCount(count((r) => d.of(r) === b))]) })),
    cost: costLine(plan, ledgerPresent),
  };
}

// The words the shareable tier may contain, all defined in this file. Nothing from private configuration, the
// corpus or the ledger is added; numbers are allowed by shape.
export function shareVocabulary() {
  const sources = [TEXT, BANDS, ENUMS, PUBLIC_DOMAIN_IDS, [OTHER]];
  return new Set(JSON.stringify(sources).toLowerCase().match(/[a-z0-9]+/g));
}

// Counts only, never the offending text: an error message must not repeat what it refuses to write.
export function shareableScan(text, vocabulary) {
  const nonAscii = (String(text).match(/[^\t\n\r\x20-\x7e]/g) ?? []).length;
  const unknownWords = (String(text).match(/[A-Za-z0-9]+/g) ?? []).filter((w) => !vocabulary.has(w.toLowerCase()) && !/^\d+$/.test(w)).length;
  return { nonAscii, unknownWords, ok: nonAscii === 0 && unknownWords === 0 };
}
