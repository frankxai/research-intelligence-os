import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawSample } from './lib.mjs';
// A namespace import, so a helper missing from an older registry.mjs fails only the tests that use it.
import * as registry from './registry.mjs';

const {
  ROLES, buildRegistry, ledgerRuns, makeRedactor, matchRun, parseJsonl, parseRedactList, phraseHash, phraseOf, readers, redactEntry,
  roleRelevance, runBuild, shareVocabulary, shareableScan, toCsv,
} = registry;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const domains = JSON.parse(readFileSync(path.join(HERE, 'domains.json'), 'utf8')).domains;
const NOW = Date.parse('2026-11-04T22:00:00Z');
// A placeholder phrase, not anyone's name: it stands in for a name on the redaction list.
const PLACEHOLDER = 'Testperson Placeholder';
const CITED = { evidence: 'cited', source_urls: 40, source_hosts: 30 };
const opaqueId = (key) => createHash('sha256').update(key).digest('hex').slice(0, 12);

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
const TIER_FILES = ['reports.csv', 'reports.jsonl', 'roles.csv', 'REGISTRY.md'];
const read = (home, tier, name) => readFileSync(path.join(home, 'registry', tier, name), 'utf8');
const rowsOf = (home, tier) => read(home, tier, 'reports.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const readRows = (home) => rowsOf(home, 'private');
const tierText = (home, tier) => TIER_FILES.map((n) => read(home, tier, n)).join('\n');
const allOutputs = (home) => `${tierText(home, 'private')}\n${tierText(home, 'shareable')}`;

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
  const { rows, shareRows } = buildRegistry({ reports: [{ key: KEY, text: STUDY }], domains, now: NOW });
  for (const r of [rows[0], shareRows[0]]) {
    assert.equal(r.release, 'unsampled');
    assert.equal(r.rank_score, 'unranked');
    assert.equal(r.score_evidence_integrity, null);
    assert.equal(r.score_verification_coverage, null);
    assert.deepEqual([r.score_source_breadth, r.score_freshness, r.score_economic_relevance], [15, 15, 15]);
  }
  assert.match(toCsv(rows, ['key', 'rank_score', 'score_evidence_integrity']), /,unranked,\n$/);
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
    const [s] = rowsOf(home, 'shareable');
    assert.deepEqual([s.release, s.release_block_count, s.checker_recorded, s.rank_score], ['blocked', r.release_blocks.length, 'yes', r.rank_score]);
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
    for (const tier of ['private', 'shareable']) assert.match(read(home, tier, 'REGISTRY.md'), /No usage ledger was found/);
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
    for (const tier of ['private', 'shareable']) assert.match(read(home, tier, 'REGISTRY.md'), /1 excluded, withheld/);
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
    assert.deepEqual(added.sort(), ['private', 'shareable'].flatMap((t) => TIER_FILES.map((n) => `registry/${t}/${n}`)).sort());
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
  const { records, manifest } = drawSample(text, { reportKey: KEY, n: 10, sampledAt: '2026-11-04T18:00:00.000Z' });
  const filled = records.map((r) => ({ ...r, status: 'verified', excerpt: 'quoted', checker: 'independent-test-checker', checked_at: '2026-11-04T19:00:00.000Z' }));
  const home = makeHome({ reports: { [KEY]: text }, verify: { [`${STEM}.claims.jsonl`]: jsonl(filled), [`${STEM}.manifest.json`]: JSON.stringify(manifest) } });
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

test('review 6.1: the shareable tier carries no character, word, key or Drive id of a confidential report', () => {
  assert.ok(![...CONFIDENTIAL].some((c) => c.charCodeAt(0) < 0x80), 'the fixture is all non-ASCII');
  const key = 'marketing/2026-11-01-zxqvsecretdossier.md';
  const driveId = 'qqzxqvdriveid77';
  const home = makeHome({ reports: { [key]: report({ title: CONFIDENTIAL, domain: 'marketing', id: driveId }), [KEY]: STUDY }, ledger: LEDGER });
  writeUnder(home, 'registry/reports.csv', `stale private copy ${key}\n`);
  try {
    runBuild({ home, now: NOW });
    assert.equal(existsSync(path.join(home, 'registry', 'reports.csv')), false, 'a stale root-level private copy is removed');
    const ids = rowsOf(home, 'shareable').map((r) => r.row_id).sort();
    assert.deepEqual(ids, [opaqueId(key), opaqueId(KEY)].sort(), 'the report is present, by opaque id only');
    for (const name of TIER_FILES) {
      const text = read(home, 'shareable', name);
      assert.doesNotMatch(text, /[^\t\n\r\x20-\x7e]/, `${name} is printable ASCII`);
      for (const cp of new Set(CONFIDENTIAL)) assert.ok(!text.includes(cp), `${name} holds U+${cp.codePointAt(0).toString(16)}`);
      assert.doesNotMatch(text, /zxqv|strasse|kompact|secretdossier|qqzxqv|creator pricing|pricing study|topic|docA/i, name);
    }
    assert.equal(rowsOf(home, 'private').find((r) => r.drive_doc_id === driveId).title, CONFIDENTIAL, 'the private tier keeps the title');
    assert.match(read(home, 'private', 'REGISTRY.md'), /PRIVATE: do not share/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
  const vocabulary = shareVocabulary(new Set(['marketing']));
  assert.deepEqual(shareableScan('| 3d12d62c8411 | marketing | pass | 2026-11-04T17:26:39.041Z |', vocabulary), { nonAscii: 0, unknownWords: 0, ok: true });
  assert.equal(shareableScan('| 3d12d62c8411 | Confidential dossier |', vocabulary).unknownWords, 2, 'free text is refused');
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
    for (const tier of ['private', 'shareable']) {
      assert.deepEqual(rowsOf(home, tier).map((r) => r.row_id), [opaqueId(KEY)], `${tier} has only the kept report`);
      const text = tierText(home, tier);
      assert.doesNotMatch(text, /alpha|bravo|charlie|secretclient|drive-id/i, tier);
      for (const k of [byId, byQuarantine, byPattern]) assert.ok(!text.includes(opaqueId(k)), `${tier} names no withheld row id`);
      assert.match(read(home, tier, 'REGISTRY.md'), /3 excluded, withheld/);
    }
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
