#!/usr/bin/env node
// Research registry: what the research corpus holds and how far each report has been checked, in two tiers.
//
//   node registry.mjs build [--allow-unredacted]
//       corpus front matter + Gemini usage ledger + claim records -> RESEARCH_HOME/registry/
//         shareable/  REGISTRY.md only: one coarse snapshot
//         private/    REGISTRY.md, reports.csv, reports.jsonl, roles.csv: one row per report: never share these
//   node registry.mjs redact-hash "<phrase>" [--label <label>]
//       prints the line to append to RESEARCH_HOME/registry/redact.sha256.txt
//
// Modules: registry-schema.mjs (vocabulary, weights, columns), registry-privacy.mjs (normalisation, redaction,
// exclusion), registry-facts.mjs (front matter, ledger, claims, scores), registry-aggregate.mjs (the coarse snapshot),
// registry-render.mjs (CSV and markdown). This file builds the registry, does the I/O and runs the CLI, and re-exports
// what the tests and other callers use.
//
// The shareable tier is one coarse file: the corpus total and one-dimension counts (public domain id, kind, evidence
// label, age band), each rounded to the nearest 10 with anything under 10 shown as '<10'; never a cross-tabulation.
// Nothing that depends on which reports were claim-checked (release verdicts, verified-rate, sampled-share and score
// bands) is published. Usage cost shows only as a band over at least ten measured runs. It carries a method note and
// its known limits: coarse by design, share one snapshot per recipient and never refresh it for the same recipient,
// the private tier is the source of truth. Before writing,
// it must be printable ASCII and use only words this file defines, or the build stops. The private tier keeps
// per-report rows, exact scores, role relevance and ledger links. Documents excluded by Drive id, quarantine or the
// pipeline's exclusion rules are withheld from both tiers, with their ledger runs, costs and claim diagnostics; the
// shareable tier never states how many.
//
// Reads RESEARCH_HOME (corpus/, quarantine/, gemini-usage.jsonl, verify/, exclude.txt, exclude-ids.txt,
// domains.local.json, registry/weights.local.json, registry/redact.sha256.txt) and writes only
// RESEARCH_HOME/registry/. The release verdict is the claim gate's own (`corpus.mjs verify score`); scores and bands only
// order review.


import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_PERSONAL_PATTERNS } from './lib.mjs';
import {
  DEFAULT_STALE_DAYS, ECONOMIC_DOMAIN_WEIGHTS, PRIVATE_COLUMNS, PRIVATE_ROLE_COLUMNS, PROBLEMS, PUBLIC_DOMAINS, TEXT, readers,
} from './registry-schema.mjs';
import { isExcluded, makeRedactor, parseRedactList, redactEntry, redactRow, sha256 } from './registry-privacy.mjs';
import {
  claimColumns, excludedRuns, headingsOf, keptPlan, ledgerColumns, ledgerRuns, matchRun, reportFacts, roleRelevance, sameTitle,
  scoreColumns, titlesOverlap,
} from './registry-facts.mjs';
import { coarseSnapshot, publicScoreBand, sampledShareBand, shareVocabulary, shareableScan, verifiedRateBand } from './registry-aggregate.mjs';
import { fmt, privateMarkdown, shareableMarkdown, toCsv } from './registry-render.mjs';

// The public surface, unchanged by the split into modules.
export {
  BANDS, ECONOMIC_DOMAIN_WEIGHTS, PRIVATE_COLUMNS, PRIVATE_ROLE_COLUMNS, PUBLIC_DOMAIN_IDS, ROLES, WEIGHTS, readers,
} from './registry-schema.mjs';
export { makeRedactor, parseRedactList, phraseHash, phraseOf, pipelineExcludes, redactEntry } from './registry-privacy.mjs';
export { excludedRuns, ledgerRuns, matchRun, parseFrontMatter, roleRelevance, scoreColumns } from './registry-facts.mjs';
export {
  coarseCount, coarseSnapshot, publicScoreBand, sampledShareBand, shareVocabulary, shareableScan, verifiedRateBand,
} from './registry-aggregate.mjs';
export { privateMarkdown, shareableMarkdown, toCsv } from './registry-render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// The registry: pure, so every rule above is testable on synthetic data. Exclusion is decided first, over every
// report and every quarantined document, and excluded documents are dropped before any row, ledger run, cost average,
// count, aggregate or claim diagnostic is computed, so neither tier can carry them.

// The private row id: the first 12 hex digits of the SHA-256 of the corpus key. Anyone who guesses a key can
// confirm it, so the id appears only in the private tier.
const rowIdOf = (key) => sha256(key).slice(0, 12);

function reportRow(f, key, text, run, ctx) {
  const created = Date.parse(f.created);
  const raw = {
    row_id: rowIdOf(key), key, title: f.title, domain: f.domain, kind: f.kind, source: f.source,
    created: f.created, age_days: Number.isNaN(created) ? null : Math.max(0, Math.floor((ctx.now - created) / DAY_MS)),
    producer: f.producer ?? (run ? 'gemini-deep-research' : 'unknown'),
    // The usage ledger, when the run recorded them, is the authority for model and mode; never invented.
    producer_mode: run?.mode ?? f.mode ?? (run ? 'deep-research' : 'unknown'), producer_model: run?.model ?? f.model ?? 'unknown',
    producer_basis: run ? 'usage-ledger' : f.producer ? 'front-matter-classifier' : 'none',
    prompt_sha256: run?.promptSha256 ?? null, prompt_bytes: run?.promptBytes ?? null,
    ...ledgerColumns(run, ctx),
    drive_doc_id: f.driveId ?? run?.docId ?? null,
    drive_doc_url: (f.driveId ?? run?.docId) ? `https://drive.google.com/open?id=${encodeURIComponent(f.driveId ?? run.docId)}` : null,
    local_path: `corpus/${key}`, source_urls: f.sourceUrls, source_hosts: f.sourceHosts, evidence: f.evidence, evidence_basis: f.evidenceBasis,
    ...claimColumns(ctx.claimSets.get(key), f, text),
  };
  raw.release_block_count = raw.release_blocks.length;
  raw.sampled_share = raw.claims_in_report ? +(raw.claims_sampled / raw.claims_in_report).toFixed(4) : null;
  Object.assign(raw, scoreColumns(raw, { staleDays: ctx.stale.get(f.domain) ?? DEFAULT_STALE_DAYS, econWeight: ctx.econ[f.domain] ?? 0 }));
  raw.score_band = publicScoreBand(raw, ctx.publicStale);
  raw.verified_rate_band = verifiedRateBand(raw);
  raw.sampled_share_band = sampledShareBand(raw);
  return raw;
}

const staleMap = (domains, only = null) => {
  const out = new Map();
  for (const d of domains) if (!out.has(d.id) && (!only || only.has(d.id))) out.set(d.id, d.staleDays);
  return out;
};

export function buildRegistry({
  reports, ledger = null, claimSets = new Map(), domains = [], publicDomains = domains, local = {}, exclusionIds = new Set(),
  quarantineKeys = new Set(), quarantineReports = [], personalPatterns = DEFAULT_PERSONAL_PATTERNS, redact = makeRedactor(),
  now = Date.now(), orphanClaimFiles = [],
}) {
  const stale = staleMap(domains);
  const publicStale = staleMap(publicDomains, PUBLIC_DOMAINS);
  const econ = { ...ECONOMIC_DOMAIN_WEIGHTS, ...(local.economicDomainWeights ?? {}) };
  const qKeys = new Set([...quarantineKeys, ...quarantineReports.map((r) => r.key)]);
  const all = [...reports].sort((a, b) => a.key.localeCompare(b.key)).map(({ key, text }) => ({ key, text, f: reportFacts(key, text, exclusionIds) }));
  const excluded = all.filter((r) => isExcluded(r, { quarantineKeys: qKeys, personalPatterns, redact }));
  const kept = all.filter((r) => !excluded.includes(r));
  // A quarantined document normally leaves corpus/, but its front matter still identifies its ledger runs.
  const corpusKeys = new Set(all.map((r) => r.key));
  const quarantined = quarantineReports.filter((r) => !corpusKeys.has(r.key)).map(({ key, text }) => reportFacts(key, text, exclusionIds));
  const excludedFacts = [...excluded.map((r) => r.f), ...quarantined];
  // The excluded Drive ids themselves, whether or not any local copy of the document still exists.
  const excludedIds = new Set([...exclusionIds, ...excludedFacts.map((f) => f.driveId).filter(Boolean)]);
  const ledgerFacts = ledger ? ledgerRuns(ledger) : { runs: [], orphanCloseRecords: [] };
  const dropped = excludedRuns(ledgerFacts.runs, excludedFacts, kept.map((r) => r.f), excludedIds);
  const runs = ledgerFacts.runs.filter((r) => !dropped.has(r));
  const ownedByExcluded = ({ title, docId }) => (docId && excludedIds.has(docId))
    || excludedFacts.some((f) => sameTitle(f.title, title) || titlesOverlap(f.title, title));
  const orphanCloses = ledgerFacts.orphanCloseRecords.filter((r) => !ownedByExcluded(r)).length;
  const plan = ledger ? keptPlan(ledger, dropped) : null;
  const keptKeys = new Set(kept.map((r) => r.key));
  const keptSets = new Map([...claimSets].filter(([k]) => keptKeys.has(k)));
  const ctx = { ledgerPresent: Boolean(ledger), costs: plan?.costs ?? [], runs, now, stale, publicStale, econ, claimSets: keptSets };
  const out = { rows: [], roleRows: [] };
  const keptRows = [];
  const matched = new Map();
  for (const { key, text, f } of kept) {
    const run = matchRun(f, runs);
    const raw = reportRow(f, key, text, run, ctx);
    if (run) matched.set(run, raw);
    keptRows.push(raw);
    // Role relevance is private-tier only.
    const relevance = roleRelevance(f.domain, { title: f.title, headings: headingsOf(f.body) }, local.roleDomains);
    const [human, agent] = readers(raw);
    const { row, hits } = redactRow(raw, redact);
    row.privacy = hits.has('denylist') ? 'redacted' : 'ok';
    out.rows.push(Object.fromEntries(PRIVATE_COLUMNS.map((c) => [c, row[c] ?? null])));
    out.roleRows.push({ row_id: row.row_id, key: row.key, title: row.title, domain: row.domain, kind: row.kind,
      evidence: row.evidence, release: row.release, ...relevance, human_reader: human, agent_reader: agent });
  }
  const runRows = runs.map((r) => ({ ...r, title: redact(r.title).text, report: matched.has(r) ? redact(matched.get(r).key, 'redacted').text : null }));
  // A claims file left by an excluded or quarantined report is not reported as an orphan either.
  const excludedStems = new Set([...excluded.map((r) => r.key), ...qKeys].map(stemOf));
  const orphans = orphanClaimFiles.filter((name) => !excludedStems.has(name.replace(/\.claims\.jsonl$/, '')));
  const problems = findProblems({ rows: out.rows, runRows, orphanCloses, claimSets: keptSets, orphanClaimFiles: orphans, econ,
    withheld: excluded.length, ledgerPresent: Boolean(ledger) });
  const snapshot = coarseSnapshot(keptRows, { plan, ledgerPresent: Boolean(ledger) });
  return { ...out, runRows, plan, problems, econ, withheld: excluded.length, snapshot };
}

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
  return checks.filter(([n]) => n > 0).map(([n, text]) => `${n} ${text}.`);
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
const readUnder = (dir) => keysUnder(dir).map((key) => ({ key, text: readFileSync(path.join(dir, ...key.split('/')), 'utf8') }));
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
  const verifyDir = path.join(home, 'verify');
  const reports = readUnder(path.join(home, 'corpus'));
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
  const publicDomains = readJson(path.join(HERE, 'domains.json'), { domains: [] }).domains;
  // Quarantined documents are read for their front matter only: it is what ties them to their ledger runs.
  const quarantineReports = readUnder(path.join(home, 'quarantine'));
  return {
    reports, claimSets, orphanClaimFiles, exclusionPhrases, publicDomains, quarantineReports,
    ledger: existsSync(usage) ? readJsonl(usage) : null,
    domains: [...readJson(path.join(home, 'domains.local.json'), { domains: [] }).domains, ...publicDomains],
    local: validateLocalWeights(readJson(weightsFile, {}), weightsFile),
    exclusionIds: new Set(readLines(path.join(home, 'exclude-ids.txt'))),
    quarantineKeys: new Set(quarantineReports.map((r) => r.key)),
    // The same list corpus.mjs classifies with: the default personal patterns plus exclude.txt.
    personalPatterns: [...DEFAULT_PERSONAL_PATTERNS, ...exclusionPhrases],
    denylist: existsSync(redactFile) ? parseRedactList(readFileSync(redactFile, 'utf8')) : null,
    redactFile,
  };
}

// Local weights are numbers only, so configuration cannot smuggle text into the private tier's scores. The error
// names the file, not the offending key or value.
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

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// Removed after every successful build: the private files older builds wrote to registry/ itself, every shareable
// file other than REGISTRY.md (older builds wrote per-report rows and then cross-tabulated aggregates there), the
// row-id salt an older build created, and any temporary file an interrupted write left behind.
const OLD_NAMES = ['reports.csv', 'reports.jsonl', 'roles.csv', 'REGISTRY.md', 'aggregates.csv'];
export const STALE_FILES = [
  ...OLD_NAMES.flatMap((n) => [n, `${n}.tmp`]),
  'shareable/reports.csv', 'shareable/reports.jsonl', 'shareable/aggregates.csv', 'shareable/roles.csv',
  ...['private', 'shareable'].flatMap((t) => OLD_NAMES.map((n) => `${t}/${n}.tmp`)),
  'private/.id-salt',
];

export function runBuild({ home, allowUnredacted = false, now = Date.now() }) {
  const input = loadHome(home);
  if (!input.denylist && !allowUnredacted) {
    throw new Error(`no redaction list at ${input.redactFile}: the private tier could name people. Add hashes with "node registry.mjs redact-hash", or pass --allow-unredacted`);
  }
  const redact = makeRedactor({ entries: input.denylist ?? [], phrases: input.exclusionPhrases });
  const reg = buildRegistry({ ...input, redact, now });
  const builtAt = new Date(now).toISOString();
  const privateCheck = input.denylist
    ? fmt(TEXT.checkedPrivate, { d: input.denylist.length, p: input.exclusionPhrases.length }) : TEXT.uncheckedPrivate;
  const files = {
    'shareable/REGISTRY.md': shareableMarkdown(reg.snapshot, { builtDay: builtAt.slice(0, 10) }),
    'private/REGISTRY.md': privateMarkdown({ ...reg, builtAt, nameCheck: privateCheck, ledgerPresent: Boolean(input.ledger),
      localKeys: new Set(Object.keys(input.local.economicDomainWeights ?? {})) }),
    'private/reports.csv': toCsv(reg.rows, PRIVATE_COLUMNS),
    'private/reports.jsonl': `${reg.rows.map((r) => JSON.stringify(r)).join('\n')}${reg.rows.length ? '\n' : ''}`,
    'private/roles.csv': toCsv(reg.roleRows, PRIVATE_ROLE_COLUMNS),
  };
  const vocabulary = shareVocabulary();
  const refused = Object.entries(files).flatMap(([name, text]) => {
    const why = [];
    if (redact(text).hits.size) why.push('matches the redaction list');
    if (name.startsWith('shareable/')) {
      const scan = shareableScan(text, vocabulary);
      if (scan.nonAscii) why.push(`${scan.nonAscii} non-ASCII character(s)`);
      if (scan.unknownWords) why.push(`${scan.unknownWords} word(s) the registry does not define`);
    }
    return why.length ? [`${name}: ${why.join(', ')}`] : [];
  });
  if (refused.length) throw new Error(`share-check failed, nothing was written: ${refused.join('; ')}`);
  const dir = path.join(home, 'registry');
  for (const [name, text] of Object.entries(files)) writeAtomic(path.join(dir, ...name.split('/')), text);
  for (const name of STALE_FILES) rmSync(path.join(dir, ...name.split('/')), { force: true });
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
