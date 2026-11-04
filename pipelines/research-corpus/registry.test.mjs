import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawSample } from './lib.mjs';
import {
  ROLES, buildRegistry, ledgerRuns, makeRedactor, matchRun, phraseHash, readers, roleRelevance, runBuild, toCsv,
} from './registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const domains = JSON.parse(readFileSync(path.join(HERE, 'domains.json'), 'utf8')).domains;
const NOW = Date.parse('2026-11-04T22:00:00Z');
// A placeholder phrase, not anyone's name: it stands in for a name on the redaction list.
const PLACEHOLDER = 'Testperson Placeholder';
const CITED = { evidence: 'cited', source_urls: 40, source_hosts: 30 };

function report({ title, domain, kind = 'deep-research', created = '2026-11-04T16:45:00.000Z', id = 'docA', evidence = CITED, body = '# Overview\n\nText.\n' }) {
  const fields = {
    title: JSON.stringify(title), source: 'google-drive', source_id: id, kind, domain, created, modified: created, exported: created,
    producer: kind === 'deep-research' ? 'gemini-deep-research' : 'gemini-chat', verification: 'unverified-ai-synthesis',
    ...(evidence ?? {}),
  };
  return `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`;
}

const TABLE_BODY = [
  '# Pricing study', '',
  '| Claim | Source URL | Date |', '|---|---|---|',
  '| Tool A costs 10 USD per month | https://a.example.com/pricing | 2026-10 |',
  '| Tool B offers a free tier | https://b.example.org/plans | 2026-10 |',
  '| Tool C supports refunds within 14 days | https://c.example.net/terms | 2026-09 |', '',
].join('\n');

const KEY = 'agentic-income-streams/2026-11-04-creator-pricing-economics-study.md';
const TITLE = 'Creator Pricing Economics Study';
const STUDY = report({ title: TITLE, domain: 'agentic-income-streams', body: TABLE_BODY });

// Meter resets are left blank so the measured cost does not depend on the test machine's time zone.
const reading = (ts, sessionPct, weeklyPct) => ({ ts, type: 'reading', sessionPct, weeklyPct, sessionResets: null, weeklyResets: null });
const LEDGER = [
  reading('2026-11-04T16:00:00.000Z', 10, 20),
  { ts: '2026-11-04T16:01:00.000Z', type: 'run', domain: 'agentic-income-streams', title: `Topic: ${TITLE}` },
  { ts: '2026-11-04T16:40:00.000Z', type: 'done', title: `Topic: ${TITLE}` },
  reading('2026-11-04T16:41:00.000Z', 40, 23),
];

// Checked records for STUDY: every claim filled in by a checker, with or without the sampling manifest.
function checkedSample(statuses) {
  const { records, manifest } = drawSample(STUDY, { reportKey: KEY, n: 10, sampledAt: '2026-11-04T18:00:00.000Z' });
  const filled = records.map((r, i) => ({
    ...r, status: statuses[i] ?? 'verified', excerpt: 'quoted from the source', checker: 'independent-test-checker', checked_at: '2026-11-04T19:00:00.000Z',
  }));
  return { records: filled, manifest };
}

function makeHome({ reports = {}, ledger = null, verify = {}, denylist = [PLACEHOLDER], exclude = [] } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'registry-test-'));
  for (const [key, text] of Object.entries(reports)) {
    const file = path.join(home, 'corpus', key);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  if (ledger) writeFileSync(path.join(home, 'gemini-usage.jsonl'), `${ledger.map((r) => JSON.stringify(r)).join('\n')}\n`);
  mkdirSync(path.join(home, 'verify'), { recursive: true });
  for (const [name, text] of Object.entries(verify)) writeFileSync(path.join(home, 'verify', name), text);
  if (denylist) {
    mkdirSync(path.join(home, 'registry'), { recursive: true });
    writeFileSync(path.join(home, 'registry', 'redact.sha256.txt'), `# test list\n${denylist.map((p) => `${phraseHash(p)}  # test`).join('\n')}\n`);
  }
  if (exclude.length) writeFileSync(path.join(home, 'exclude.txt'), `${exclude.join('\n')}\n`);
  return home;
}

const jsonl = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
const STEM = 'agentic-income-streams__2026-11-04-creator-pricing-economics-study';
const readRows = (home) => readFileSync(path.join(home, 'registry', 'reports.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function filesUnder(dir) {
  return readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? filesUnder(path.join(dir, n)).map((f) => `${n}/${f}`) : [n]));
}

test('a row carries front matter, ledger timing, measured cost and Drive provenance', () => {
  const { rows } = buildRegistry({ reports: [{ key: KEY, text: STUDY }], ledger: LEDGER, domains, now: NOW });
  const [r] = rows;
  assert.equal(r.producer, 'gemini-deep-research');
  assert.equal(r.producer_mode, 'deep-research');
  assert.equal(r.producer_model, 'unknown', 'a model nobody recorded is never invented');
  assert.equal(r.producer_basis, 'usage-ledger');
  assert.equal(r.run_started, '2026-11-04T16:01:00.000Z');
  assert.equal(r.run_finished, '2026-11-04T16:40:00.000Z');
  assert.equal(r.cost_basis, 'measured');
  assert.equal(r.window_pct_cost, 30);
  assert.equal(r.weekly_pct_cost, 3);
  assert.equal(r.drive_doc_id, 'docA');
  assert.equal(r.drive_doc_url, 'https://drive.google.com/open?id=docA');
  assert.equal(r.local_path, `corpus/${KEY}`);
  assert.deepEqual([r.source_urls, r.source_hosts, r.evidence, r.evidence_basis], [40, 30, 'cited', 'front-matter']);
  assert.equal(r.privacy, 'ok');
});

test('an unsampled report is unranked and has no claim-derived scores', () => {
  const { rows } = buildRegistry({ reports: [{ key: KEY, text: STUDY }], domains, now: NOW });
  const [r] = rows;
  assert.equal(r.release, 'unsampled');
  assert.equal(r.rank_score, 'unranked');
  assert.equal(r.score_evidence_integrity, null);
  assert.equal(r.score_verification_coverage, null);
  assert.deepEqual([r.score_source_breadth, r.score_freshness, r.score_economic_relevance], [15, 15, 15]);
  const csv = toCsv(rows, ['key', 'rank_score', 'score_evidence_integrity']);
  assert.match(csv, /,unranked,\n$/);
});

test('a contradicted claim blocks release but the report is still ranked for review', () => {
  const { records } = checkedSample(['contradicted', 'verified', 'verified']);
  const home = makeHome({ reports: { [KEY]: STUDY }, verify: { [`${STEM}.claims.jsonl`]: jsonl(records) } });
  try {
    runBuild({ home, now: NOW });
    const [r] = readRows(home);
    assert.equal(r.release, 'blocked');
    assert.ok(r.release_blocks.some((b) => /contradicted/.test(b)));
    assert.ok(r.release_blocks.some((b) => /no sampling manifest/.test(b)), 'the gate also wants the manifest');
    assert.deepEqual([r.claims_sampled, r.claims_verified, r.claims_contradicted, r.claims_in_report], [3, 2, 1, 3]);
    assert.equal(r.checker, 'independent-test-checker');
    assert.equal(typeof r.rank_score, 'number');
    assert.equal(r.score_evidence_integrity, 26.7);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a fully verified sample with its manifest passes and scores every component in full', () => {
  const { records, manifest } = checkedSample([]);
  const home = makeHome({
    reports: { [KEY]: STUDY },
    verify: { [`${STEM}.claims.jsonl`]: jsonl(records), [`${STEM}.manifest.json`]: JSON.stringify(manifest), [`${STEM}.claims.checked-backup.jsonl`]: jsonl(records) },
  });
  try {
    runBuild({ home, now: NOW });
    const [r] = readRows(home);
    assert.equal(r.release, 'pass', JSON.stringify(r.release_blocks));
    assert.equal(r.rank_score, 100);
    assert.equal(r.claims_backup, 'identical');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('without a usage ledger the run and cost columns stay blank and the producer comes from front matter', () => {
  const home = makeHome({ reports: { [KEY]: STUDY } });
  try {
    runBuild({ home, now: NOW });
    const [r] = readRows(home);
    assert.deepEqual([r.run_started, r.run_finished, r.window_pct_cost, r.weekly_pct_cost], [null, null, null, null]);
    assert.equal(r.cost_basis, 'no-ledger');
    assert.equal(r.producer, 'gemini-deep-research');
    assert.equal(r.producer_basis, 'front-matter-classifier');
    assert.equal(r.producer_mode, 'unknown');
    assert.match(readFileSync(path.join(home, 'registry', 'REGISTRY.md'), 'utf8'), /No usage ledger was found/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the ledger never matches an abandoned run, a run outside the time window, or a short title', () => {
  const ledger = [
    { ts: '2026-11-04T10:00:00.000Z', type: 'run', domain: 'x', title: TITLE },
    { ts: '2026-11-04T10:30:00.000Z', type: 'abandoned', title: TITLE, at: '2026-11-04T10:20:00.000Z' },
    { ts: '2026-11-04T11:00:00.000Z', type: 'abandoned', title: `${TITLE} typo` },
  ];
  const { runs, orphanCloses } = ledgerRuns(ledger);
  assert.equal(runs[0].status, 'abandoned');
  assert.equal(orphanCloses, 1, 'a close record whose title matches no run is counted');
  assert.equal(matchRun({ title: TITLE, created: '2026-11-04T10:25:00.000Z' }, runs), null);
  const done = ledgerRuns([{ ts: '2026-11-01T10:00:00.000Z', type: 'run', title: TITLE }, { ts: '2026-11-01T10:30:00.000Z', type: 'done', title: TITLE }]).runs;
  assert.equal(matchRun({ title: TITLE, created: '2026-11-04T10:25:00.000Z' }, done), null, 'days later is another report');
  assert.equal(matchRun({ title: 'Study', created: '2026-11-01T10:31:00.000Z' }, done), null, 'one word is too weak to match');
  assert.ok(matchRun({ title: TITLE, created: '2026-11-01T10:31:00.000Z' }, done));
});

test('a listed name is redacted from every output, keys keep a slug shape, and the share-check passes', () => {
  const key = 'marketing/2026-11-01-testperson-placeholder-positioning-brief.md';
  const home = makeHome({ reports: { [key]: report({ title: `${PLACEHOLDER} — Positioning Brief`, domain: 'marketing' }) } });
  try {
    runBuild({ home, now: NOW });
    for (const name of ['reports.csv', 'reports.jsonl', 'roles.csv', 'REGISTRY.md']) {
      assert.doesNotMatch(readFileSync(path.join(home, 'registry', name), 'utf8'), /testperson/i, name);
    }
    const [r] = readRows(home);
    assert.equal(r.key, 'marketing/2026-11-01-redacted-positioning-brief.md');
    assert.equal(r.title, '[redacted] — Positioning Brief');
    assert.equal(r.privacy, 'redacted');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the redactor normalizes case and separators and reports what matched', () => {
  assert.equal(phraseHash('TESTPERSON-placeholder'), phraseHash(PLACEHOLDER.toLowerCase()));
  const redact = makeRedactor({ hashes: [phraseHash(PLACEHOLDER)], phrases: ['secret_client'] });
  const a = redact(`Notes on ${PLACEHOLDER}'s plan`);
  assert.equal(a.text, "Notes on [redacted]'s plan");
  assert.deepEqual([...a.hits], ['denylist']);
  const b = redact('Secret Client onboarding');
  assert.equal(b.text, '[redacted] onboarding');
  assert.deepEqual([...b.hits], ['exclusion']);
  assert.equal(redact('Nothing to hide').hits.size, 0);
});

test('a title matching a private exclusion pattern once separators are normalized is flagged and redacted', () => {
  const key = 'marketing/2026-11-01-notes.md';
  const home = makeHome({ reports: { [key]: report({ title: `${PLACEHOLDER} Notes`, domain: 'marketing' }) }, denylist: [], exclude: ['# private', 'testperson_placeholder'] });
  try {
    runBuild({ home, now: NOW });
    const [r] = readRows(home);
    assert.equal(r.privacy, 'exclusion-match');
    assert.equal(r.title, '[redacted] Notes');
    assert.match(readFileSync(path.join(home, 'registry', 'REGISTRY.md'), 'utf8'), /1 report\(s\) match a private exclusion pattern/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('build fails closed without a redaction list and writes only under registry/ when it runs', () => {
  const home = makeHome({ reports: { [KEY]: STUDY }, ledger: LEDGER, denylist: null });
  try {
    const before = filesUnder(home);
    const cli = (args) => spawnSync(process.execPath, [path.join(HERE, 'registry.mjs'), ...args], { env: { ...process.env, RESEARCH_HOME: home }, encoding: 'utf8' });
    const refused = cli(['build']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /no redaction list/);
    assert.equal(existsSync(path.join(home, 'registry')), false, 'nothing is written on refusal');
    const allowed = cli(['build', '--allow-unredacted']);
    assert.equal(allowed.status, 0, allowed.stderr);
    const added = filesUnder(home).filter((f) => !before.includes(f));
    assert.deepEqual(added.sort(), ['registry/REGISTRY.md', 'registry/reports.csv', 'registry/reports.jsonl', 'registry/roles.csv']);
    assert.match(readFileSync(path.join(home, 'registry', 'REGISTRY.md'), 'utf8'), /Not checked for personal names/);
    assert.match(readFileSync(path.join(home, 'registry', 'REGISTRY.md'), 'utf8'), /Weights are hypotheses/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('role relevance is 0-3, follows domain and keywords, and readers follow the release state', () => {
  const rel = roleRelevance('agentic-income-streams', { title: 'Creator Pricing and Refund Economics', headings: 'Checkout flows \n Subscription tiers' });
  for (const role of Object.keys(ROLES)) assert.ok(Number.isInteger(rel[role]) && rel[role] >= 0 && rel[role] <= 3, role);
  assert.equal(rel['pricing-and-monetization'], 3);
  assert.equal(rel['support-agent'], 0);
  assert.equal(rel['research-analyst'], 1, 'every domain is background for the research analyst');
  const local = roleRelevance('private-domain', { title: 'Plain title', headings: '' }, { 'brand-and-voice': { 'private-domain': 2 } });
  assert.equal(local['brand-and-voice'], 2, 'private domain bases come from the local weights file');
  const [passHuman, passAgent] = readers({ release: 'pass' });
  const [openHuman] = readers({ release: 'unsampled', evidence: 'cited', kind: 'deep-research', source: 'google-drive' });
  assert.notEqual(passHuman, openHuman);
  assert.match(passAgent, /claim records/);
});

test('CSV cells are quoted and a leading formula character is neutralized', () => {
  const csv = toCsv([{ a: '=SUM(1)', b: 'x, "y"', c: ['one', 'two'], d: null, e: 3 }], ['a', 'b', 'c', 'd', 'e']);
  assert.equal(csv, `a,b,c,d,e\n'=SUM(1),"x, ""y""",one; two,,3\n`);
});
