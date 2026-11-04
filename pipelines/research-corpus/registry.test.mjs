import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERSONAL_PATTERNS, classifyKind, drawSample } from './lib.mjs';
// A namespace import, so a helper missing from an older registry.mjs fails only the tests that use it.
import * as registry from './registry.mjs';

const {
  PUBLIC_DOMAIN_IDS, ROLES, buildRegistry, ledgerRuns, makeRedactor, matchRun, parseJsonl, parseRedactList, phraseHash, phraseOf,
  pipelineExcludes, readers, redactEntry, roleRelevance, runBuild, shareVocabulary, shareableScan, toCsv, coarseCount, verifiedRateBand,
  sampledShareBand,
} = registry;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const domains = JSON.parse(readFileSync(path.join(HERE, 'domains.json'), 'utf8')).domains;
const NOW = Date.parse('2026-11-04T22:00:00Z');
// A placeholder phrase, not anyone's name: it stands in for a name on the redaction list.
const PLACEHOLDER = 'Testperson Placeholder';
const CITED = { evidence: 'cited', source_urls: 40, source_hosts: 30 };
const plainId = (key) => createHash('sha256').update(key).digest('hex').slice(0, 12);

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

// Checked records for a report: every claim filled in by a checker, plus the sampling manifest.
function checkedSampleOf(text, key, statuses = []) {
  const { records, manifest } = drawSample(text, { reportKey: key, n: 10, sampledAt: '2026-11-04T18:00:00.000Z' });
  const filled = records.map((r, i) => ({
    ...r, status: statuses[i] ?? 'verified', excerpt: 'quoted from the source', checker: 'independent-test-checker', checked_at: '2026-11-04T19:00:00.000Z',
  }));
  return { records: filled, manifest };
}
const checkedSample = (statuses) => checkedSampleOf(STUDY, KEY, statuses);

function writeUnder(root, rel, text) {
  const file = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function makeHome({ reports = {}, ledger = null, verify = {}, denylist = [PLACEHOLDER], exclude = [], excludeIds = [], quarantine = {} } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'registry-test-'));
  for (const [key, text] of Object.entries(reports)) writeUnder(home, `corpus/${key}`, text);
  for (const [key, text] of Object.entries(quarantine)) writeUnder(home, `quarantine/${key}`, text);
  if (ledger) writeFileSync(path.join(home, 'gemini-usage.jsonl'), `${ledger.map((r) => JSON.stringify(r)).join('\n')}\n`);
  mkdirSync(path.join(home, 'verify'), { recursive: true });
  for (const [name, text] of Object.entries(verify)) writeFileSync(path.join(home, 'verify', name), text);
  if (denylist) {
    const line = (p) => `${phraseHash(p)} ${phraseOf(p).split(' ').length}  # test`;
    writeUnder(home, 'registry/redact.sha256.txt', `# test list\n${denylist.map(line).join('\n')}\n`);
  }
  if (exclude.length) writeFileSync(path.join(home, 'exclude.txt'), `${exclude.join('\n')}\n`);
  if (excludeIds.length) writeFileSync(path.join(home, 'exclude-ids.txt'), `${excludeIds.join('\n')}\n`);
  return home;
}

const jsonl = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
const STEM = 'agentic-income-streams__2026-11-04-creator-pricing-economics-study';
const FILES = { private: ['reports.csv', 'reports.jsonl', 'roles.csv', 'REGISTRY.md'], shareable: ['REGISTRY.md'] };
const read = (home, tier, name) => readFileSync(path.join(home, 'registry', tier, name), 'utf8');
const readRows = (home) => read(home, 'private', 'reports.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const tierText = (home, tier) => FILES[tier].map((n) => read(home, tier, n)).join('\n');
const allOutputs = (home) => `${tierText(home, 'private')}\n${tierText(home, 'shareable')}`;
const shared = (home) => read(home, 'shareable', 'REGISTRY.md');
// A table row of the shareable snapshot, e.g. cellOf(md, '50-69%') -> 'some'.
const cellOf = (md, bucket) => md.match(new RegExp(`^\\| ${bucket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| ([^|]+) \\|$`, 'm'))?.[1].trim();
const HEX12 = /\b[0-9a-f]{12}\b/;

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
  assert.equal(r.row_id, plainId(KEY));
});

test('an unsampled report is unranked and has no claim-derived scores', () => {
  const { rows, snapshot } = buildRegistry({ reports: [{ key: KEY, text: STUDY }], domains, now: NOW });
  const [r] = rows;
  assert.equal(r.release, 'unsampled');
  assert.equal(r.rank_score, 'unranked');
  assert.equal(r.score_band, 'unranked');
  assert.equal(r.score_evidence_integrity, null);
  assert.equal(r.score_verification_coverage, null);
  assert.deepEqual([r.score_source_breadth, r.score_freshness, r.score_economic_relevance], [15, 15, 15]);
  assert.match(toCsv(rows, ['key', 'rank_score', 'score_evidence_integrity']), /,unranked,\n$/);
  assert.deepEqual(snapshot.presence.find((d) => d.id === 'score').cells.find(([b]) => b === 'A'), ['A', 'none']);
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
    assert.match(shared(home), /^- Blocked: some\.$/m, 'the shareable tier says only that something is blocked');
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
    assert.equal(r.score_band, 'A');
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
    assert.match(read(home, 'private', 'REGISTRY.md'), /No usage ledger was found/);
    assert.match(read(home, 'shareable', 'REGISTRY.md'), /No usage ledger\./);
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
    assert.doesNotMatch(allOutputs(home), /testperson/i);
    const [r] = readRows(home);
    assert.equal(r.key, 'marketing/2026-11-01-redacted-positioning-brief.md');
    assert.equal(r.title, '[redacted] — Positioning Brief');
    assert.equal(r.privacy, 'redacted');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the redactor normalizes case and separators and reports what matched', () => {
  assert.equal(phraseHash('TESTPERSON-placeholder'), phraseHash(PLACEHOLDER.toLowerCase()));
  const redact = makeRedactor({ entries: [redactEntry(PLACEHOLDER)], phrases: ['secret_client'] });
  const a = redact(`Notes on ${PLACEHOLDER}'s plan`);
  assert.equal(a.text, "Notes on [redacted]'s plan");
  assert.deepEqual([...a.hits], ['denylist']);
  const b = redact('Secret Client onboarding');
  assert.equal(b.text, '[redacted] onboarding');
  assert.deepEqual([...b.hits], ['exclusion']);
  assert.equal(redact('Nothing to hide').hits.size, 0);
});

test('a title matching a private exclusion pattern once separators are normalized is withheld from both tiers', () => {
  const key = 'marketing/2026-11-01-notes.md';
  const home = makeHome({ reports: { [key]: report({ title: `${PLACEHOLDER} Notes`, domain: 'marketing' }), [KEY]: STUDY }, denylist: [], exclude: ['# private', 'testperson_placeholder'] });
  try {
    runBuild({ home, now: NOW });
    assert.deepEqual(readRows(home).map((r) => r.key), [KEY]);
    assert.doesNotMatch(allOutputs(home), /testperson|2026-11-01-notes/i);
    assert.match(read(home, 'private', 'REGISTRY.md'), /1 excluded, withheld/);
    const shared = read(home, 'shareable', 'REGISTRY.md');
    assert.match(shared, /if any, are withheld from every figure in this file/);
    assert.doesNotMatch(shared, /excluded, withheld|a few/, 'the shareable tier never states how many');
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
    const expected = Object.entries(FILES).flatMap(([tier, names]) => names.map((n) => `registry/${tier}/${n}`));
    assert.deepEqual(added.sort(), expected.sort());
    assert.match(read(home, 'private', 'REGISTRY.md'), /Not checked for personal names/);
    for (const tier of ['private', 'shareable']) assert.match(read(home, tier, 'REGISTRY.md'), /Weights are hypotheses/);
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

// ---------------------------------------------------------------------------------------------
// Regressions from the cross-family review of ee6d84f, one per finding.

test('review 1: a redaction phrase of any length is redacted, and a list line without a word count stops the build', () => {
  const long = 'Alpha Bravo Charlie Delta Echo';
  const key = 'marketing/2026-11-01-alpha-bravo-charlie-delta-echo-notes.md';
  const home = makeHome({ reports: { [key]: report({ title: `${long} notes`, domain: 'marketing' }) }, denylist: [long] });
  try {
    runBuild({ home, now: NOW });
    assert.doesNotMatch(allOutputs(home), /charlie/i, 'a five-word phrase leaks if only short phrases are searched');
    assert.equal(readRows(home)[0].privacy, 'redacted');
    writeFileSync(path.join(home, 'registry', 'redact.sha256.txt'), `${phraseHash(long)}  # count missing\n`);
    rmSync(path.join(home, 'registry', 'private', 'REGISTRY.md'));
    assert.throws(() => runBuild({ home, now: NOW }), /word count/);
    assert.equal(existsSync(path.join(home, 'registry', 'private', 'REGISTRY.md')), false, 'nothing is written when the list is refused');
  } finally { rmSync(home, { recursive: true, force: true }); }
  const cli = spawnSync(process.execPath, [path.join(HERE, 'registry.mjs'), 'redact-hash', long, '--label', 'test'], { encoding: 'utf8' });
  assert.equal(cli.stdout.trim(), `${phraseHash(long)} 5  # test`);
});

test('review 2: composed, decomposed, full-width and case-folded forms of a listed phrase are all redacted', () => {
  const composed = 'Téstperson Placeholder';
  const key = 'marketing/2026-11-01-téstperson-placeholder-brief.md';
  const home = makeHome({ reports: { [key]: report({ title: 'Téstperson Placeholder brief', domain: 'marketing' }) }, denylist: [composed] });
  try {
    runBuild({ home, now: NOW });
    assert.doesNotMatch(allOutputs(home).normalize('NFKD').replace(/\p{M}/gu, ''), /testperson|placeholder/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
  assert.equal(phraseHash('Téstperson Placeholder'), phraseHash(composed));
  assert.equal(phraseHash('STRASSE'), phraseHash('straße'), 'full case folding');
  const redact = makeRedactor({ entries: [redactEntry(composed)] });
  const variants = ['Téstperson Placeholder', 'Téstperson Placeholder', 'Ｔｅ́ｓｔperson PLACEHOLDER', 'TÉSTPERSON-placeholder'];
  for (const variant of variants) {
    assert.equal(redact(`Notes on ${variant} today`).text, 'Notes on [redacted] today', JSON.stringify(variant));
  }
});

test('review 3: CSV cells that open with a formula character after whitespace or controls, or in full width, are neutralized', () => {
  const risky = ['\n=1+1', '＝1+1', '  @cmd', '\t1', '－1', '\r\n+1', '＋1', '＠x', '\u0007=1'];
  for (const value of risky) {
    const cellText = toCsv([{ a: value }], ['a']).slice('a\n'.length);
    assert.match(cellText, /^"?'/, JSON.stringify(value));
  }
  assert.equal(toCsv([{ a: 'plain', b: 'a-b' }], ['a', 'b']), 'a,b\nplain,a-b\n');
});

test('review 4: a whitespace-only line in a claims file blocks the registry exactly as it fails verify score', () => {
  const { records, manifest } = checkedSample([]);
  const lines = records.map((r) => JSON.stringify(r));
  const verify = (home) => spawnSync(process.execPath, [path.join(HERE, 'corpus.mjs'), 'verify', 'score', KEY], { env: { ...process.env, RESEARCH_HOME: home }, encoding: 'utf8' });
  const cases = [[`${lines.join('\n')}\n`, 'pass', true], [`${lines[0]}\n   \n${lines.slice(1).join('\n')}\n`, 'blocked', false]];
  for (const [claims, release, exitOk] of cases) {
    const home = makeHome({ reports: { [KEY]: STUDY }, verify: { [`${STEM}.claims.jsonl`]: claims, [`${STEM}.manifest.json`]: JSON.stringify(manifest) } });
    try {
      runBuild({ home, now: NOW });
      assert.equal(readRows(home)[0].release, release);
      assert.equal(verify(home).status === 0, exitOk, 'verify score agrees with the registry');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  assert.throws(() => parseJsonl(`${lines[0]}\n   \n${lines[1]}\n`), SyntaxError);
});

test('review 5: guidance for a passing report covers only the supported sampled claims', () => {
  const [human, agent] = readers({ release: 'pass' });
  for (const text of [human, agent]) {
    assert.doesNotMatch(text, /numbers hold|report is (true|verified)/i);
    assert.match(text, /unverified/);
  }
  assert.match(human, /sampled claims/);
  assert.match(agent, /claim records/);
});

test('review 6: coverage counts claims in every extraction mode, so a table-only sample cannot reach rank 100', () => {
  const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
  const prose = ['kilo', 'lima', 'mike', 'november', 'oscar'];
  const body = [
    '# Study', '', '| Claim | Source URL | Date |', '|---|---|---|',
    ...names.map((n) => `| Tool ${n} offers a free plan | https://${n}.example.com/plans | 2026-10 |`), '',
    ...prose.flatMap((n, i) => [`Vendor ${n} raised its list price this year per its blog${i + 1}.`, '']),
    '## Works cited', '', ...prose.map((n, i) => `${i + 1}. Vendor ${n} blog, https://${n}.example.org/post`), '',
  ].join('\n');
  const text = report({ title: TITLE, domain: 'agentic-income-streams', body });
  const { records, manifest } = checkedSampleOf(text, KEY);
  const home = makeHome({ reports: { [KEY]: text }, verify: { [`${STEM}.claims.jsonl`]: jsonl(records), [`${STEM}.manifest.json`]: JSON.stringify(manifest) } });
  try {
    runBuild({ home, now: NOW });
    const [r] = readRows(home);
    assert.equal(r.release, 'pass', JSON.stringify(r.release_blocks));
    assert.equal(r.claims_in_report, 15);
    assert.equal(r.score_verification_coverage, 10);
    assert.equal(r.rank_score, 95);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('review 7: a report saved with lone CR line endings keeps its source and Drive id, and its exclusion still applies', () => {
  const kept = report({ title: TITLE, domain: 'agentic-income-streams', id: 'kept-doc' }).replace(/\n/g, '\r');
  const excludedKey = 'marketing/2026-11-01-quarantined-doc.md';
  const excluded = report({ title: 'Quarantined Doc', domain: 'marketing', id: 'quarantined-doc' }).replace(/\n/g, '\r');
  const reg = buildRegistry({ reports: [{ key: KEY, text: kept }, { key: excludedKey, text: excluded }], domains, exclusionIds: new Set(['quarantined-doc']), now: NOW });
  assert.equal(reg.withheld, 1, 'the excluded Drive id is read from a lone-CR file');
  const [r] = reg.rows;
  assert.deepEqual([reg.rows.length, r.source, r.drive_doc_id, r.title], [1, 'google-drive', 'kept-doc', TITLE]);
});

// ---------------------------------------------------------------------------------------------
// Regressions from the cross-family review of 0c224fe: two tiers, withheld exclusions, hardened denylist.

// A synthetic confidential title made only of non-ASCII code points: circled and full-width letters, zero-width and
// bidi controls, a soft hyphen, Cyrillic look-alikes of Latin capitals, both German sharp s forms and no-break spaces.
const CONFIDENTIAL = [
  'ⓏⓍⓆⓋ', '​­‮', 'КОМРАСТ', '⁦ＺＸＱＶ⁩',
  'ＳＴＲＡẞＥ', 'ｓｔｒａßｅ‍',
].join(' ');

test('review 6.1: the shareable tier carries no character, word, key, id or Drive id of a confidential report', () => {
  assert.ok(![...CONFIDENTIAL].some((c) => c.charCodeAt(0) < 0x80), 'the fixture is all non-ASCII');
  const key = 'marketing/2026-11-01-zxqvsecretdossier.md';
  const driveId = 'qqzxqvdriveid77';
  const home = makeHome({ reports: { [key]: report({ title: CONFIDENTIAL, domain: 'marketing', id: driveId }), [KEY]: STUDY }, ledger: LEDGER });
  writeUnder(home, 'registry/reports.csv', `stale private copy ${key}\n`);
  try {
    runBuild({ home, now: NOW });
    assert.equal(existsSync(path.join(home, 'registry', 'reports.csv')), false, 'a stale root-level private copy is removed');
    for (const name of FILES.shareable) {
      const text = read(home, 'shareable', name);
      assert.doesNotMatch(text, /[^\t\n\r\x20-\x7e]/, `${name} is printable ASCII`);
      for (const cp of new Set(CONFIDENTIAL)) assert.ok(!text.includes(cp), `${name} holds U+${cp.codePointAt(0).toString(16)}`);
      assert.doesNotMatch(text, /zxqv|strasse|kompact|secretdossier|qqzxqv|creator pricing|pricing study|topic|docA/i, name);
      assert.doesNotMatch(text, HEX12, `${name} carries no per-report id`);
    }
    assert.equal(readRows(home).find((r) => r.drive_doc_id === driveId).title, CONFIDENTIAL, 'the private tier keeps the title');
    assert.match(read(home, 'private', 'REGISTRY.md'), /PRIVATE: do not share/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
  const vocabulary = shareVocabulary();
  assert.deepEqual(shareableScan('| marketing | <10 | some | none | 2026 |', vocabulary), { nonAscii: 0, unknownWords: 0, ok: true });
  assert.equal(shareableScan('| 3d12d62c8411 | Confidential dossier |', vocabulary).unknownWords, 3, 'an id and free text are refused');
  assert.equal(shareableScan('café', vocabulary).nonAscii, 1);
});

test('review 6.2: documents excluded by Drive id, quarantine or exclusion pattern are withheld from both tiers', () => {
  const byId = 'marketing/2026-11-01-withheld-alpha.md';
  const byQuarantine = 'marketing/2026-11-01-withheld-bravo.md';
  const byPattern = 'marketing/2026-11-01-withheld-charlie.md';
  const home = makeHome({
    reports: {
      [KEY]: STUDY,
      [byId]: report({ title: 'Alpha Confidential Memo', domain: 'marketing', id: 'excluded-drive-id' }),
      [byQuarantine]: report({ title: 'Bravo Confidential Memo', domain: 'marketing', id: 'bravo-drive-id' }),
      [byPattern]: report({ title: 'Charlie Secretclient Memo', domain: 'marketing', id: 'charlie-drive-id' }),
    },
    quarantine: { [byQuarantine]: 'quarantined copy\n' }, excludeIds: ['excluded-drive-id'], exclude: ['secretclient'], denylist: [],
  });
  try {
    runBuild({ home, now: NOW });
    assert.deepEqual(readRows(home).map((r) => r.key), [KEY], 'the private tier has only the kept report');
    for (const tier of ['private', 'shareable']) {
      const text = tierText(home, tier);
      assert.doesNotMatch(text, /alpha|bravo|charlie|secretclient|drive-id/i, tier);
      for (const k of [byId, byQuarantine, byPattern]) assert.ok(!text.includes(plainId(k)), `${tier} names no withheld row id`);
    }
    assert.match(read(home, 'private', 'REGISTRY.md'), /3 excluded, withheld/);
    assert.doesNotMatch(read(home, 'shareable', 'REGISTRY.md'), /\b3\b.*withheld|withheld.*\b3\b/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('review 6.3: the private-tier denylist ignores format characters, folds circled and full-width letters, and treats both sharp s forms alike', () => {
  const redact = makeRedactor({ entries: [redactEntry(PLACEHOLDER), redactEntry('Straße Research')] });
  const variants = [
    'Test­person Placeholder', 'Test​person Placeholder', 'Testp‍erson Placeholder', 'Test‮person‬ Placeholder',
    '⁦Testperson⁩ Placeholder', 'Ⓣestperson Placeholder', 'Ｔｅｓｔｐｅｒｓｏｎ Placeholder',
    'STRAẞE RESEARCH', 'STRASSE research', 'straße Research',
  ];
  for (const v of variants) assert.equal(redact(`Notes on ${v} today`).text, 'Notes on [redacted] today', JSON.stringify(v));
  // Documented limit: a Cyrillic look-alike is a different letter, so the denylist misses it; the shareable tier,
  // which carries no report text at all, is what covers that case (review 6.1).
  assert.equal(redact('Тestperson Placeholder').hits.size, 0);
  const key = 'marketing/2026-11-01-circled-brief.md';
  const home = makeHome({ reports: { [key]: report({ title: 'Ⓣest­person Placeholder brief', domain: 'marketing' }) } });
  try {
    runBuild({ home, now: NOW });
    const [r] = readRows(home);
    assert.deepEqual([r.title, r.privacy], ['[redacted] brief', 'redacted']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('review 6.4: a word count that is not a positive safe integer stops the build', () => {
  const hash = phraseHash(PLACEHOLDER);
  for (const count of ['9'.repeat(400), '0', '9007199254740993']) {
    assert.throws(() => parseRedactList(`${hash} ${count}  # bad\n`), /positive whole word count/, count.slice(0, 20));
  }
  assert.deepEqual(parseRedactList(`# comment\n${hash} 2  # ok\n`), [{ hash, words: 2 }]);
  const home = makeHome({ reports: { [KEY]: STUDY } });
  try {
    writeFileSync(path.join(home, 'registry', 'redact.sha256.txt'), `${hash} ${'9'.repeat(400)}  # overflow\n`);
    assert.throws(() => runBuild({ home, now: NOW }), /positive whole word count/);
    assert.equal(existsSync(path.join(home, 'registry', 'shareable')), false, 'nothing is written');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// Regressions from the cross-family review of 873a48b: public schema, excluded runs, pipeline parity, legacy files.

test('review 7.1: private configuration cannot put a domain id or weight key into the shareable tier', () => {
  const urlDomain = 'https://drive.google.com/open?id=SECRETDOMAIN1';
  const home = makeHome({ reports: { 'marketing/2026-11-01-private-domain-report.md': report({ title: 'Plain Market Study', domain: urlDomain }), [KEY]: STUDY } });
  writeUnder(home, 'domains.local.json', JSON.stringify({ domains: [{ id: urlDomain, name: 'private', staleDays: 14, keywords: [] }] }));
  writeUnder(home, 'registry/weights.local.json', JSON.stringify({ economicDomainWeights: { [urlDomain]: 0.5, unusedsecretweightkey: 0.9 } }));
  try {
    runBuild({ home, now: NOW });
    assert.doesNotMatch(tierText(home, 'shareable'), /drive\.google|secretdomain1|open\?id|unusedsecretweightkey/i);
    assert.match(read(home, 'private', 'REGISTRY.md'), /unusedsecretweightkey 0\.9/, 'the private tier still lists private weights');
    writeUnder(home, 'registry/weights.local.json', JSON.stringify({ economicDomainWeights: { marketing: 'agent strategy report' } }));
    assert.throws(() => runBuild({ home, now: NOW }), /must be a number from 0 to 1/, 'a weight cannot carry text');
  } finally { rmSync(home, { recursive: true, force: true }); }
  for (const { id } of domains) assert.ok(PUBLIC_DOMAIN_IDS.includes(id), `public domains.json id ${id} is mirrored in the schema`);
});

test('review 7.2: an excluded report leaves no ledger run, cost, timestamp or claim diagnostic in either tier', () => {
  const secretKey = 'marketing/2026-11-03-withheld-acquisition-plan.md';
  const secretTitle = 'Zulu Acquisition Plan Memo';
  const ledger = [
    reading('2026-11-03T08:00:00.000Z', 0, 10),
    { ts: '2026-11-03T08:01:11.000Z', type: 'run', domain: 'marketing', title: 'Unrelated Prompt Words Here' },
    { ts: '2026-11-03T08:30:00.000Z', type: 'done', title: 'Unrelated Prompt Words Here' },
    reading('2026-11-03T08:31:00.000Z', 11, 12),
    reading('2026-11-03T09:13:00.000Z', 11, 12),
    { ts: '2026-11-03T09:13:37.000Z', type: 'run', domain: 'marketing', title: secretTitle },
    { ts: '2026-11-03T09:47:11.000Z', type: 'done', title: secretTitle },
    reading('2026-11-03T09:48:00.000Z', 48, 19),
    ...LEDGER,
  ];
  const home = makeHome({
    reports: { [KEY]: STUDY, [secretKey]: report({ title: secretTitle, domain: 'marketing', id: 'excluded-drive-id', created: '2026-11-03T09:50:00.000Z' }) },
    ledger, excludeIds: ['excluded-drive-id'], verify: { 'marketing__2026-11-03-withheld-acquisition-plan.claims.jsonl': 'not json\n' },
  });
  try {
    runBuild({ home, now: NOW });
    for (const tier of ['private', 'shareable']) {
      const text = tierText(home, tier);
      assert.doesNotMatch(text, /08:01:11|08:30:00|09:13:37|09:47:11|zulu|acquisition|unrelated prompt/i, `${tier}: no trace of either excluded run`);
      assert.doesNotMatch(text, /could not be read/, `${tier}: no claim diagnostic from the excluded report`);
    }
    const priv = read(home, 'private', 'REGISTRY.md');
    assert.match(priv, /Measured runs: 1\. Mean cost per measured run: window 30%, weekly 3%/, 'averages over kept runs only');
    assert.match(priv, /\| Usage-ledger runs \/ matched to a report \/ with a measured cost \| 1 \/ 1 \/ 1 \|/);
    assert.match(priv, /1 excluded, withheld/);
    assert.match(read(home, 'shareable', 'REGISTRY.md'), /Insufficient data: fewer than 5 measured runs/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('review 7.3: the registry withholds every title the pipeline classifier excludes', () => {
  const patterns = [...DEFAULT_PERSONAL_PATTERNS, 'secretclient'];
  const titles = ['Secretclient2026 Research', 'Quarterly Journal Review Notes', 'Term Sheet Draft For Review', 'Plain Market Study'];
  const reports = Object.fromEntries(titles.map((t, i) => [`marketing/2026-11-0${i + 1}-doc-${i}.md`, report({ title: t, domain: 'marketing', id: `doc-${i}` })]));
  const home = makeHome({ reports, exclude: ['secretclient'], denylist: [] });
  try {
    runBuild({ home, now: NOW });
    assert.deepEqual(readRows(home).map((r) => r.title), ['Plain Market Study']);
    assert.doesNotMatch(allOutputs(home), /secretclient|journal|term sheet/i);
    assert.match(read(home, 'private', 'REGISTRY.md'), /3 excluded, withheld/);
  } finally { rmSync(home, { recursive: true, force: true }); }
  for (const t of titles) assert.equal(pipelineExcludes(t, patterns), ['personal', 'sensitive'].includes(classifyKind({ title: t }, patterns)), t);
});

test('review 7.5: migration removes legacy outputs and the temporary files an interrupted write left behind', () => {
  const home = makeHome({ reports: { [KEY]: STUDY } });
  const stale = ['reports.csv', 'reports.jsonl.tmp', 'reports.csv.tmp', 'roles.csv.tmp', 'REGISTRY.md.tmp', 'private/reports.jsonl.tmp', 'shareable/REGISTRY.md.tmp'];
  for (const s of stale) writeUnder(home, `registry/${s}`, `stale private copy ${TITLE}\n`);
  try {
    runBuild({ home, now: NOW });
    for (const s of stale) assert.equal(existsSync(path.join(home, 'registry', ...s.split('/'))), false, s);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// The 70% verified-rate gate and run details recorded in the usage ledger.

// A ten-claim synthetic study: the minimum sample is ten, so every claim is checked.
const TEN_CLAIMS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
const TEN_STUDY = report({ title: TITLE, domain: 'agentic-income-streams', body: [
  '# Study', '', '| Claim | Source URL | Date |', '|---|---|---|',
  ...TEN_CLAIMS.map((n) => `| Tool ${n} offers a free plan | https://${n}.example.com/plans | 2026-10 |`), '',
].join('\n') });

test('verified-rate gate: a sample of six verified and four partial claims is blocked in the registry, and pass guidance never licenses partials', () => {
  const { records, manifest } = drawSample(TEN_STUDY, { reportKey: KEY, n: 10, sampledAt: '2026-11-04T18:00:00.000Z' });
  const fill = (verified) => records.map((r, i) => ({
    ...r, status: i < verified ? 'verified' : 'partial', excerpt: 'quoted', checker: 'independent-test-checker', checked_at: '2026-11-04T19:00:00.000Z',
  }));
  for (const [verified, release] of [[6, 'blocked'], [7, 'pass']]) {
    const home = makeHome({ reports: { [KEY]: TEN_STUDY }, verify: { [`${STEM}.claims.jsonl`]: jsonl(fill(verified)), [`${STEM}.manifest.json`]: JSON.stringify(manifest) } });
    try {
      runBuild({ home, now: NOW });
      const [r] = readRows(home);
      assert.equal(r.release, release, JSON.stringify(r.release_blocks));
      if (release === 'blocked') assert.ok(r.release_blocks.some((b) => /verified rate 60% is below the 70% minimum/.test(b)));
      assert.match(shared(home), release === 'pass' ? /^- Passes: some\.$/m : /^- Blocked: some\.$/m, 'the shareable tier gives the verdict as some or none');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  for (const text of readers({ release: 'pass' })) assert.doesNotMatch(text, /verified (or|and) partial/i);
});

// Run transparency: model, mode, prompt hash and Drive doc id come from the usage ledger when it recorded them.
const DOC_ID = '1PlaceholderDoc_0123';
const PROMPT_SHA = createHash('sha256').update('synthetic prompt for a placeholder run').digest('hex');
const detailedLedger = ({ model = 'Gemini 3 Pro', domain = 'agentic-income-streams' } = {}) => [
  reading('2026-11-04T16:00:00.000Z', 10, 20),
  { ts: '2026-11-04T16:01:00.000Z', type: 'run', domain, title: 'Unrelated run label', model, mode: 'Deep Research',
    prompt_sha256: PROMPT_SHA, prompt_bytes: 38, note: 'synthetic run note' },
  { ts: '2026-11-04T16:40:00.000Z', type: 'done', title: 'Unrelated run label', doc_id: DOC_ID },
  reading('2026-11-04T16:41:00.000Z', 40, 23),
];

test('run details from the ledger: the private tier keeps the labels; the shareable tier has no model, prompt hash or run detail', () => {
  const study = report({ title: TITLE, domain: 'agentic-income-streams', id: DOC_ID, body: TABLE_BODY });
  for (const model of ['Gemini 3 Pro', '3 Pro', 'Some Future Model X']) {
    const home = makeHome({ reports: { [KEY]: study }, ledger: detailedLedger({ model }) });
    try {
      runBuild({ home, now: NOW });
      const [r] = readRows(home);
      assert.equal(r.run_started, '2026-11-04T16:01:00.000Z', 'matched by Drive doc id, although the titles differ');
      assert.deepEqual([r.producer_model, r.producer_mode, r.prompt_sha256, r.prompt_bytes, r.drive_doc_id], [model, 'Deep Research', PROMPT_SHA, 38, DOC_ID]);
      const shareText = tierText(home, 'shareable');
      for (const s of [PROMPT_SHA.slice(0, 12), model, 'Deep Research', '16:01', DOC_ID]) assert.ok(!shareText.includes(s), `shareable holds ${s}`);
      assert.ok(!allOutputs(home).includes('synthetic run note'), 'the run note stays in the ledger');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test('a run closed with an excluded document\'s Drive id is withheld with it, even in another domain and under another title', () => {
  const excluded = report({ title: 'Withheld Placeholder Study', domain: 'agentic-income-streams', id: DOC_ID, body: TABLE_BODY });
  const { runRows, rows } = buildRegistry({ reports: [{ key: KEY, text: excluded }], ledger: detailedLedger({ domain: 'marketing' }), domains, now: NOW,
    exclusionIds: new Set([DOC_ID]) });
  assert.equal(rows.length, 0);
  assert.equal(runRows.length, 0, 'the doc-linked run is dropped before any ledger table or count');
});

// ---------------------------------------------------------------------------------------------
// Regressions from the cross-family review of 0603d1a: the shareable tier becomes aggregate-only.

// A ledger with one run per entry in `runs` ([title, domain, startIso, endIso, windowCost, weeklyCost, docId?]), each
// measured on its own between two readings, followed by `tail` (by default LEDGER, itself one measured run). A docId
// closes the run as `usage done --doc-id` would.
function measuredLedger(runs, tail = LEDGER) {
  let session = 0;
  let weekly = 10;
  return [...runs.flatMap(([title, domain, start, end, w, k, docId]) => {
    const before = reading(new Date(Date.parse(start) - 60_000).toISOString(), session, weekly);
    session += w;
    weekly += k;
    const done = { ts: end, type: 'done', title, ...(docId ? { doc_id: docId } : {}) };
    return [before, { ts: start, type: 'run', domain, title }, done, reading(new Date(Date.parse(end) + 60_000).toISOString(), session, weekly)];
  }), ...tail];
}
const separateRuns = (n) => [...Array(n)].map((_, i) => [`Separate run ${i} prompt words`, 'marketing', `2026-10-2${i}T10:00:00.000Z`, `2026-10-2${i}T10:30:00.000Z`, 30, 3]);

test('review 8.1: a quarantined document that left corpus/ still withholds its ledger runs and costs', () => {
  const qTitle = 'Quarantined Strategy Memo Alpha';
  const ledger = measuredLedger([[qTitle, 'business-strategy', '2026-11-03T09:13:37.000Z', '2026-11-03T09:47:11.000Z', 37, 7]]);
  const home = makeHome({
    reports: { [KEY]: STUDY }, ledger,
    quarantine: { 'marketing/2026-11-03-quarantined-memo.md': report({ title: qTitle, domain: 'marketing', id: 'q-doc', created: '2026-11-03T09:50:00.000Z' }) },
  });
  try {
    runBuild({ home, now: NOW });
    for (const tier of ['private', 'shareable']) assert.doesNotMatch(tierText(home, tier), /09:13:37|09:47:11|quarantined strategy/i, tier);
    const priv = read(home, 'private', 'REGISTRY.md');
    assert.match(priv, /Measured runs: 1\. Mean cost per measured run: window 30%, weekly 3%/, 'the quarantined run is not averaged');
    assert.match(priv, /\| Usage-ledger runs \/ matched to a report \/ with a measured cost \| 1 \/ 1 \/ 1 \|/);
    assert.match(read(home, 'shareable', 'REGISTRY.md'), /Insufficient data/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('review 8.2: a short excluded title withholds its identically titled run and close records in any domain', () => {
  const ledger = [
    ...measuredLedger([['Acme Buyout', 'business-strategy', '2026-11-02T07:07:07.000Z', '2026-11-02T07:37:37.000Z', 30, 3]]),
    { ts: '2026-11-02T08:00:00.000Z', type: 'abandoned', title: 'acme buyout', at: '2026-11-02T07:59:00.000Z' },
  ];
  const home = makeHome({ reports: { [KEY]: STUDY, 'marketing/2026-11-02-acme-buyout.md': report({ title: 'Acme Buyout', domain: 'marketing', id: 'acme-doc' }) },
    ledger, excludeIds: ['acme-doc'] });
  try {
    runBuild({ home, now: NOW });
    for (const tier of ['private', 'shareable']) assert.doesNotMatch(tierText(home, tier), /07:07:07|07:37:37|acme/i, tier);
    const priv = read(home, 'private', 'REGISTRY.md');
    assert.match(priv, /Measured runs: 1\./, 'only the kept run is measured');
    assert.doesNotMatch(priv, /name a title that matches no run/, 'the short-title close record is not counted either');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('review 8.3: private weights, role bases and refresh windows cannot be recovered from the shareable tier', () => {
  const key = 'marketing/2026-11-04-creator-pricing-economics-study.md';
  const text = report({ title: TITLE, domain: 'marketing', body: TABLE_BODY });
  const { records, manifest } = checkedSampleOf(text, key);
  const stem = 'marketing__2026-11-04-creator-pricing-economics-study';
  const build = (withPrivate) => {
    const home = makeHome({ reports: { [key]: text, [KEY]: STUDY }, verify: { [`${stem}.claims.jsonl`]: jsonl(records), [`${stem}.manifest.json`]: JSON.stringify(manifest) } });
    if (withPrivate) {
      writeUnder(home, 'registry/weights.local.json', JSON.stringify({ economicDomainWeights: { marketing: 0.42 }, roleDomains: { 'creator-media': { marketing: 2 } } }));
      writeUnder(home, 'domains.local.json', JSON.stringify({ domains: [{ id: 'marketing', name: 'private', staleDays: 1, keywords: [] }] }));
    }
    runBuild({ home, now: NOW });
    return home;
  };
  const [withPrivate, without] = [build(true), build(false)];
  try {
    assert.equal(readRows(withPrivate).find((r) => r.key === key).score_economic_relevance, 6.3, 'the private tier uses the private weight');
    for (const name of FILES.shareable) {
      assert.equal(read(withPrivate, 'shareable', name), read(without, 'shareable', name), `${name} does not depend on private configuration`);
      assert.doesNotMatch(read(withPrivate, 'shareable', name), /6\.3|0\.42/, name);
    }
  } finally { for (const h of [withPrivate, without]) rmSync(h, { recursive: true, force: true }); }
});

test('review 8.4: the row-id salt is gone; private ids are the plain key hash and the shareable tier has no ids', () => {
  const home = makeHome({ reports: { [KEY]: STUDY } });
  writeUnder(home, 'registry/private/.id-salt', `${'a'.repeat(64)}\n`);
  writeUnder(home, 'registry/shareable/reports.jsonl', `{"row_id":"${plainId(KEY)}"}\n`);
  writeUnder(home, 'registry/shareable/reports.csv', 'row_id\n');
  writeUnder(home, 'registry/shareable/aggregates.csv', 'dimension,bucket,reports\n');
  writeUnder(home, 'registry/shareable/roles.csv', 'role,domain,reports_relevance_2_plus\n');
  try {
    runBuild({ home, now: NOW });
    assert.equal(existsSync(path.join(home, 'registry', 'private', '.id-salt')), false, 'an old salt file is deleted');
    assert.deepEqual(readdirSync(path.join(home, 'registry', 'shareable')), ['REGISTRY.md'], 'every older shareable file is deleted');
    assert.equal(readRows(home)[0].row_id, plainId(KEY));
    assert.match(read(home, 'private', 'REGISTRY.md'), /first 12 hex digits of the SHA-256 of the corpus key/);
    assert.doesNotMatch(tierText(home, 'shareable'), HEX12);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('review 8.5: usage cost shows only as a band over at least five measured runs', () => {
  const reports = Object.fromEntries([...Array(6)].map((_, i) => [`marketing/2026-11-0${i + 1}-study-${i}.md`, report({ title: `Market study number ${i} draft`, domain: i < 5 ? 'marketing' : 'community', id: `m-${i}` })]));
  for (const [n, cost] of [[4, /Insufficient data/], [5, /window 25-49%, weekly 2-4%/]]) {
    const home = makeHome({ reports, ledger: measuredLedger(separateRuns(n), []), denylist: [] });
    try {
      runBuild({ home, now: NOW });
      assert.match(shared(home), cost, `${n} measured runs`);
      assert.doesNotMatch(shared(home), /\b30%|\b3%/, 'no exact mean is published');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

// ---------------------------------------------------------------------------------------------
// Regressions from the cross-family review of a16531c. Findings 1, 2 and 4 (small-cell suppression defeated by
// complements, cross-file subtraction and successive snapshots) are superseded by design: one coarse file with rounded
// one-dimension counts and some/none for anything claim-check related. Findings 3 and 5 are fixed.

test('review 9.1/9.2/9.4: one coarse file, rounded counts, no cross-tabulation, and adding a report changes nothing at small sizes', () => {
  const corpus = (n) => Object.fromEntries([...Array(n)].map((_, i) => {
    const domain = i === 0 ? 'community' : i <= 5 ? 'marketing' : 'business-strategy';
    return [`${domain}/2026-11-0${(i % 9) + 1}-memo-${i}.md`, report({ title: `Brand memo ${i}`, domain, id: `b-${i}` })];
  }));
  const build = (n) => {
    const home = makeHome({ reports: corpus(n), denylist: [] });
    runBuild({ home, now: NOW });
    return home;
  };
  const [eleven, five, six] = [build(11), build(5), build(6)];
  try {
    const md = shared(eleven);
    assert.deepEqual(['community', 'marketing', 'business-strategy'].map((d) => cellOf(md, d)), ['<10', '<10', '<10'], 'the reviewer\'s [1, 5, 5] table');
    assert.match(md, /^Reports: 10 \(rounded/m, 'the total is rounded too');
    assert.doesNotMatch(md, /hidden|<5|relevance >=|product-strategist|growth-and-distribution|brand-and-voice/i, 'no masking scheme and no role cross-tab');
    assert.deepEqual(readdirSync(path.join(eleven, 'registry', 'shareable')), ['REGISTRY.md'], 'a single shareable file');
    assert.match(md, /no more often than monthly/);
    assert.match(md, /^- Passes: none\.$/m);
    assert.equal(shared(five), shared(six), 'a snapshot of five reports and one of six are identical: the added report is not visible');
  } finally { for (const h of [eleven, five, six]) rmSync(h, { recursive: true, force: true }); }
  assert.deepEqual([0, 1, 9, 10, 14, 15, 114].map(coarseCount), ['<10', '<10', '<10', '10', '10', '20', '110']);
});

test('review 9.3: a run or close record carrying an excluded Drive id is dropped even when no copy of that document exists', () => {
  const runs = [...separateRuns(4), ['Unrelated prompt for a removed document', 'web3-general', '2026-10-28T10:00:00.000Z', '2026-10-28T10:30:00.000Z', 30, 3, 'gone-doc-id-0001']];
  const ledger = [...measuredLedger(runs, []), { ts: '2026-10-29T08:00:00.000Z', type: 'abandoned', title: 'Typo title nobody started', doc_id: 'gone-doc-id-0001' }];
  const home = makeHome({ reports: { [KEY]: STUDY }, ledger, excludeIds: ['gone-doc-id-0001'] });
  try {
    runBuild({ home, now: NOW });
    const priv = read(home, 'private', 'REGISTRY.md');
    assert.match(priv, /Measured runs: 4\./, 'four eligible runs stay four');
    assert.doesNotMatch(priv, /removed document|2026-10-28T10|name a title that matches no run/i, 'neither the run nor its close record is reported');
    assert.match(shared(home), /Insufficient data: fewer than 5 measured runs/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('review 9.5: verified-rate and sampled-share bands come from whole counts in both tiers', () => {
  const table = (n) => ['# Large study', '', '| Claim | Source URL | Date |', '|---|---|---|',
    ...Array.from({ length: n }, (_, i) => `| Tool number ${i} offers plan option ${i} today | https://t${i}.example.com/p | 2026-10 |`), ''].join('\n');
  const keyA = 'marketing/2026-11-04-verified-boundary-study.md';
  const keyB = 'marketing/2026-11-04-sampled-boundary-study.md';
  const records = (key, n, status) => jsonl(Array.from({ length: n }, (_, i) => ({ id: `${key}#${i}`, report_key: key, status: status(i) })));
  const home = makeHome({
    reports: { [keyA]: report({ title: 'Verified boundary study', domain: 'marketing', id: 'va', body: table(2000) }),
      [keyB]: report({ title: 'Sampled boundary study', domain: 'marketing', id: 'sb', body: table(10000) }) },
    verify: {
      'marketing__2026-11-04-verified-boundary-study.claims.jsonl': records(keyA, 2000, (i) => (i < 1399 ? 'verified' : 'partial')),
      'marketing__2026-11-04-sampled-boundary-study.claims.jsonl': records(keyB, 2499, () => 'partial'),
    },
    denylist: [],
  });
  try {
    runBuild({ home, now: NOW });
    const rows = Object.fromEntries(readRows(home).map((r) => [r.key, r]));
    assert.deepEqual([rows[keyA].claims_verified, rows[keyA].claims_checked, rows[keyA].verified_rate, rows[keyA].verified_rate_band], [1399, 2000, 0.6995, '50-69%'],
      'private: 69.95% is under 70%');
    assert.deepEqual([rows[keyB].claims_sampled, rows[keyB].claims_in_report, rows[keyB].sampled_share, rows[keyB].sampled_share_band], [2499, 10000, 0.2499, '10-24%'],
      'private: 24.99% is under 25%');
    const md = shared(home);
    assert.deepEqual(['50-69%', '70% or more', '10-24%', '25-49%'].map((b) => cellOf(md, b)), ['some', 'none', 'some', 'none'], 'shareable: the same bands');
  } finally { rmSync(home, { recursive: true, force: true }); }
  assert.equal(verifiedRateBand({ release: 'blocked', claims_checked: 2000, claims_verified: 1400 }), '70% or more', '70.00% is 70% or more');
  assert.equal(sampledShareBand({ release: 'blocked', claims_sampled: 2500, claims_in_report: 10000 }), '25-49%', '25.00% is 25% or more');
});
