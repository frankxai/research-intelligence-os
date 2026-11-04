import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  briefMarkdown, catalogMarkdown, classify, classifyKind, evidenceStats, chunkMarkdown, bm25Rank, corpusKey, dueDomains, frontMatter,
  localFrontMatter, routeDomain, usageToday, usagePlan, parseWorksCited, splitCitations, extractClaims, sampleClaims, claimRecords,
  scoreClaims, pipelineHealth, claimSignals, openRunFor, reportDigest, drawSample, CLAIM_SCHEMA,
} from './lib.mjs';

const domains = JSON.parse(readFileSync(new URL('./domains.json', import.meta.url), 'utf8')).domains;
const DOC = 'application/vnd.google-apps.document';
const doc = (id, title, fileSize, createdTime = '2026-10-28T10:00:00Z') =>
  ({ id, title, mimeType: DOC, fileSize: String(fileSize), createdTime, modifiedTime: createdTime });

test('a long untitled-style Doc is a Deep Research report routed by keyword', () => {
  const [e] = classify([doc('a', 'AI Agent Knowledge Layers Architecture', 217676)], { domains });
  assert.equal(e.kind, 'deep-research');
  assert.equal(e.domain, 'ai-models-platforms');
  assert.equal(e.include, true);
});

test('a short Codex/Blueprint Doc is a Gemini write-up, not research evidence', () => {
  const [e] = classify([doc('b', 'Sonic OS — Master Blueprint & AI Agent Directive', 9683)], { domains });
  assert.equal(e.kind, 'gemini-canvas');
});

test('personal documents are excluded and get no domain', () => {
  const [e] = classify([doc('c', 'Self-Analysis_-_Frank__v6_', 32489)], { domains });
  assert.equal(e.kind, 'personal');
  assert.equal(e.include, false);
  assert.equal(e.domain, null);
});

test('owner-supplied patterns exclude private titles the defaults miss', () => {
  const [e] = classify([doc('d', 'Our Horizon & Sanctuary', 30000)], { domains, personalPatterns: ['sanctuary'] });
  assert.equal(e.include, false);
});

test('a report exported or re-run under the same title keeps only the newest copy', () => {
  const out = classify([
    doc('early', 'Future of Human Evolution', 41033, '2026-10-28T21:45:57Z'),
    doc('late', 'Future of Human Evolution', 33747, '2026-10-28T21:49:38Z'),
  ], { domains });
  const early = out.find((e) => e.id === 'early');
  assert.equal(early.duplicateOf, 'late');
  assert.equal(early.include, false);
  assert.equal(out.find((e) => e.id === 'late').include, true);
});

test('a dossier or decision write-up is not mistaken for Deep Research', () => {
  const [e] = classify([doc('h', 'FrankX — Editorial Intelligence — Curated Dossier', 25644)], { domains });
  assert.equal(e.kind, 'gemini-canvas');
});

test('unknown size (rclone reports -1) falls back to the title', () => {
  const [e] = classify([{ ...doc('e', 'Future of Human Evolution', 0), fileSize: -1 }], { domains });
  assert.equal(e.kind, 'deep-research');
});

test('routeDomain returns unrouted when nothing matches', () => {
  assert.equal(routeDomain('Allow', domains), 'unrouted');
});

test('agentic-income-streams routes monetization and pack reports before generic agent keyword', () => {
  const [report] = classify([doc('inc1', 'Agentic Income Streams and Polar.sh Pack Economics', 142000)], { domains });
  assert.equal(report.kind, 'deep-research');
  assert.equal(report.domain, 'agentic-income-streams');
  const [runtime] = classify([doc('rt1', 'AI Agent Knowledge Layers Architecture', 217676)], { domains });
  assert.equal(runtime.domain, 'ai-models-platforms');
});

test('front matter marks every report as unverified AI synthesis', () => {
  const [e] = classify([doc('f', 'Cloudflare and Vercel Architecture Hub', 364108)], { domains });
  const fm = frontMatter(e, '2026-11-01T00:00:00Z');
  assert.match(fm, /verification: unverified-ai-synthesis/);
  assert.match(fm, /producer: gemini-deep-research/);
  assert.equal(corpusKey(e), 'ai-models-platforms/2026-10-28-cloudflare-and-vercel-architecture-hub.md');
});

test('a domain is due when never researched or older than its window', () => {
  const inventory = classify([doc('g', 'Solana validator economics deep dive', 50000, '2026-10-01T00:00:00Z')], { domains });
  const now = Date.parse('2026-11-01T00:00:00Z');
  const due = dueDomains(inventory, domains, now);
  const solana = due.find((d) => d.id === 'solana');
  assert.equal(solana.ageDays, 31);
  assert.equal(solana.due, true);
  assert.equal(due.find((d) => d.id === 'bitcoin').ageDays, null);
});

test('usageToday counts only today\'s runs and returns the latest snapshot', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const ledger = [
    { ts: '2026-10-31T09:00:00Z', type: 'run', domain: 'solana' },
    { ts: '2026-11-01T08:00:00Z', type: 'run', domain: 'solana' },
    { ts: '2026-11-01T09:00:00Z', type: 'snapshot', remaining: 17 },
  ];
  const u = usageToday(ledger, now);
  assert.equal(u.runs, 1);
  assert.equal(u.lastSnapshot.remaining, 17);
});

test('the brief ranks gateway models by release date and skips batch variants', () => {
  const gateway = [
    { id: 'old/model', type: 'language', created: 1, released: 1700000000, context_window: 128000, pricing: { input: '0.000003', output: '0.000015' } },
    { id: 'new/model', type: 'language', created: 1, released: Date.parse('2026-09-01T00:00:00Z') / 1000, context_window: 1000000, pricing: { input: '0.000005', output: '0.000025' } },
    { id: 'new/model-batch', type: 'language', created: 1, released: 1790000000 },
    { id: 'img/model', type: 'image', created: 1, released: 1795000000 },
  ];
  const md = briefMarkdown({ now: new Date('2026-11-01T00:00:00Z'), workersAi: null, gateway, inventory: [], due: [], usage: { runs: 0, lastSnapshot: null } });
  const lines = md.split('\n').filter((l) => l.startsWith('- `'));
  assert.equal(lines[0], '- `new/model` (2026-09-01, 1000k ctx, $5/$25 per M in/out)');
  assert.ok(!md.includes('model-batch') && !md.includes('img/model'));
});

test('a local file is a draft unless its committed revision is known', () => {
  const base = { title: 'TRUTH', sourcePath: 'C:/x/TRUTH.md', domain: 'business-strategy', kind: 'estate-truth', modified: '2026-10-31T00:00:00Z' };
  assert.match(localFrontMatter({ ...base, commit: null }, 'now'), /verification: working-tree-draft/);
  const committed = localFrontMatter({ ...base, commit: 'abc123' }, 'now');
  assert.match(committed, /source_commit: abc123/);
  assert.match(committed, /verification: committed-estate-document/);
});

test('the searchable catalog lists Workers AI text models and labels itself as measured', () => {
  const md = catalogMarkdown({
    now: new Date('2026-11-02T00:00:00Z'),
    workersAi: [
      { name: '@cf/a/old', task: { name: 'Text Generation' }, created_at: '2026-01-01 00:00:00', description: 'old' },
      { name: '@cf/a/new', task: { name: 'Text Generation' }, created_at: '2026-10-17 00:00:00', description: 'new' },
      { name: '@cf/a/embed', task: { name: 'Text Embeddings' }, created_at: '2026-10-20 00:00:00' },
    ],
    gateway: null,
  });
  assert.match(md, /verification: measured-from-provider-api/);
  assert.ok(md.indexOf('@cf/a/new') < md.indexOf('@cf/a/old'));
  assert.ok(!md.includes('@cf/a/embed'));
});

test('the brief degrades honestly when catalogs are unavailable', () => {
  const md = briefMarkdown({ now: new Date('2026-11-01T00:00:00Z'), workersAi: null, gateway: null, inventory: [], due: [], usage: { runs: 0, lastSnapshot: null } });
  assert.match(md, /Workers AI: catalog unavailable/);
  assert.match(md, /No app reading recorded yet/);
});

test('usagePlan measures percent cost per run and projects runs left', () => {
  const ledger = [
    { ts: '2026-11-04T10:00:00Z', type: 'reading', sessionPct: 2, weeklyPct: 4 },
    { ts: '2026-11-04T10:01:00Z', type: 'run', domain: 'solana', title: 'a' },
    { ts: '2026-11-04T10:40:00Z', type: 'done', title: 'a' },
    { ts: '2026-11-04T10:41:00Z', type: 'reading', sessionPct: 12, weeklyPct: 6 },
    { ts: '2026-11-04T11:00:00Z', type: 'run', domain: 'bitcoin', title: 'b' },
    { ts: '2026-11-04T11:30:00Z', type: 'done', title: 'b' },
    { ts: '2026-11-04T11:31:00Z', type: 'reading', sessionPct: 22, weeklyPct: 8 },
  ];
  const plan = usagePlan(ledger);
  assert.equal(plan.measuredRuns, 2);
  assert.equal(plan.weeklyPerRun, 2);
  assert.equal(plan.sessionPerRun, 10);
  assert.equal(plan.runsLeftThisWeek, 46);
  assert.equal(plan.runsLeftThisWindow, 7);
  assert.equal(plan.runsPerWeek, 50);
});

test('usagePlan skips overlapping runs and runs without a reading on both sides', () => {
  const ledger = [
    { ts: '2026-11-04T10:00:00Z', type: 'reading', sessionPct: 0, weeklyPct: 0 },
    { ts: '2026-11-04T10:01:00Z', type: 'run', title: 'a' },
    { ts: '2026-11-04T10:02:00Z', type: 'run', title: 'b' },
    { ts: '2026-11-04T10:40:00Z', type: 'done', title: 'a' },
    { ts: '2026-11-04T10:41:00Z', type: 'done', title: 'b' },
    { ts: '2026-11-04T10:42:00Z', type: 'reading', sessionPct: 20, weeklyPct: 4 },
  ];
  const plan = usagePlan(ledger);
  assert.equal(plan.measuredRuns, 0);
  assert.equal(plan.runsLeftThisWeek, null);
});

test('classifyKind treats rclone-exported native Docs (markdown, size -1) as documents but not uploaded .md files', () => {
  const native = { title: 'Long Research Report', mimeType: 'text/markdown; charset=utf-8', fileSize: -1 };
  const uploaded = { title: 'readme', mimeType: 'text/markdown; charset=utf-8', fileSize: 4200 };
  assert.equal(classifyKind(native, []), 'deep-research');
  assert.equal(classifyKind(uploaded, []), 'other');
});

test('classifyKind excludes sensitive business records and superseded copies', () => {
  const doc = (title) => ({ title, mimeType: 'text/markdown; charset=utf-8', fileSize: -1 });
  assert.equal(classifyKind(doc('Reconciled financing package rev4'), []), 'sensitive');
  assert.equal(classifyKind(doc('Meeting started 2026/07/14 - Notes by Gemini'), []), 'sensitive');
  assert.equal(classifyKind(doc('14 SUPERSEDED by 15 plan'), []), 'superseded');
  assert.equal(classifyKind(doc('Old research [SUPERSEDED_BY_REV4.1]'), []), 'superseded');
  assert.equal(classifyKind(doc('Archive - old research'), []), 'superseded');
  assert.equal(classifyKind(doc('Agent runtime research 2026'), []), 'deep-research');
});

test('evidenceStats marks reports with enough distinct sources as cited', () => {
  const urls = Array.from({ length: 12 }, (_, i) => `https://site${i % 6}.example.com/page${i}`).join('\n');
  assert.equal(evidenceStats(`# Report\n\n${urls}\n\n## Sources\n`).cited, true);
  assert.equal(evidenceStats('# Notes\n\nNo links here.').cited, false);
});

test('chunkMarkdown keeps headings and parses front matter; bm25Rank ranks the matching passage first', () => {
  const md = '---\ntitle: "T"\nkind: deep-research\n---\n# Pricing\n\nFounding discount rules for digital goods.\n\n## Refunds\n\nWithdrawal right waiver for digital content.\n';
  const { meta, chunks } = chunkMarkdown(md);
  assert.equal(meta.kind, 'deep-research');
  assert.ok(chunks.some((c) => c.heading === 'Refunds'));
  const hits = bm25Rank(chunks, 'withdrawal waiver digital content', { limit: 2 });
  assert.equal(hits[0].heading, 'Refunds');
});

// A shortened Google Docs markdown export: escaped punctuation, glued superscript citations.
const REPORT = [
  '---', 'title: "R"', 'kind: deep-research', '---',
  '# **Report**', '',
  'Studios moved to credit pools (Cursor, Lovable)1. Payments use x402 and the Machine Payments Protocol, MPP)2.', '',
  '## **Claims**', '',
  '| Category | Specific Claim / Metric | Primary Source URL | Date / Vintage |',
  '| :---- | :---- | :---- | :---- |',
  String.raw`| **MoR (Polar)** | Starter ($0/mo,5%+50¢),Pro($20/mo, 3.8%+40¢) and Meters track usage1. | https\://polar.sh/blog/introducing-polar-plans | Published **20 May 2026**; Effective **27 May 2026**2 |`,
  String.raw`| **Runtimes** | Trigger.dev v4 bills compute at \$0.10 per hour1. | https\://trigger.dev/pricing, https\://trigger.dev/docs | as of **4 Nov 2026** |`,
  String.raw`| **Runtimes** | AI SDK 7 ships durable agents2. | https\://vercel.com/blog/ai-sdk-7 | 1 Dec 20262; |`,
  '', '#### **Works cited**', '',
  String.raw`> 1. Pricing \- Trigger, [https\://trigger.dev/pricing](https://trigger.dev/pricing)  `,
  String.raw`> 2. AI SDK 7 is now available \| Vercel, [https\://vercel.com/blog/ai-sdk-7](https://vercel.com/blog/ai-sdk-7)  `,
].join('\n');
// What a checker writes beside a status (synthetic).
const EVIDENCE = { excerpt: 'verbatim source text', checked_at: '2026-11-04T12:00:00Z', checker: 'independent-checker' };
// A synthetic report with n table claims, each citing its own source.
const tableReport = (n) => ['---', 'title: "T"', 'kind: deep-research', '---', '# T', '',
  '| Category | Claim | Source URL |', '| :-- | :-- | :-- |',
  ...Array.from({ length: n }, (_, i) => `| c${i % 3} | Synthetic fact number ${i} holds. | https://source${i}.example/page |`), ''].join('\n');
// The records `verify sample` writes for a report under d/r.md, and the gate `verify score` applies.
const sampleOf = (text, n = 10) => drawSample(text, { reportKey: 'd/r.md', n, seed: 1, sampledAt: 'now' }).records;
const scoreOf = (records, text = REPORT) => scoreClaims(records, { reportKey: 'd/r.md', reportText: text });

test('parseWorksCited reads numbered entries with escaped titles and link targets', () => {
  const refs = parseWorksCited(REPORT);
  assert.equal(refs.size, 2);
  assert.deepEqual(refs.get(2), { title: 'AI SDK 7 is now available | Vercel', url: 'https://vercel.com/blog/ai-sdk-7' });
});

test('splitCitations strips glued citation numbers but keeps x402, v4, model versions and prices', () => {
  assert.deepEqual(splitCitations('tracking6. Cline)1. **2026**59; Dec 2026110;', 200), { text: 'tracking. Cline). **2026**; Dec 2026;', refs: [6, 1, 59, 110] });
  assert.deepEqual(splitCitations('Effective **27 May 2026**59', 200), { text: 'Effective **27 May 2026**', refs: [59] });
  const keep = 'x402 and v4 cost $0.10 on gpt-6.1-sol, K2.6, GB10 and AI SDK 7, as of **4 Nov 2026** (**12 May**), base64 encoding, int8 and mp4 files';
  assert.deepEqual(splitCitations(keep, 200), { text: keep, refs: [] });
  assert.deepEqual(splitCitations('$20/user/mo5.', 200), { text: '$20/user/mo.', refs: [5] });
  assert.equal(splitCitations('tracking600.', 139).text, 'tracking600.', 'a number above the works-cited count is not a citation');
});

test('extractClaims reads the claims table: clean text, unescaped URLs, mapped refs and deterministic signals', () => {
  const claims = extractClaims(REPORT);
  assert.equal(claims.length, 3);
  const [polar, trigger, sdk] = claims;
  assert.equal(polar.origin, 'table');
  assert.equal(polar.category, 'MoR (Polar)');
  assert.ok(polar.claim.endsWith('Meters track usage.'));
  assert.deepEqual(polar.sourceUrls, ['https://polar.sh/blog/introducing-polar-plans']);
  assert.equal(polar.claimedDate, 'Published 20 May 2026; Effective 27 May 2026');
  assert.deepEqual(polar.citedRefs, [{ n: 1, url: 'https://trigger.dev/pricing' }]);
  assert.ok(polar.claimRaw.includes('usage1.'), 'the raw cell is kept for the checker');
  assert.ok(polar.signals.includes('spacing-lost'));
  assert.ok(polar.signals.includes('url-not-in-works-cited'));
  assert.ok(polar.signals.includes('ref-differs-from-source-url'));
  assert.deepEqual(claimSignals('fable ($10/$50, $0.25cache),claude-opus-5-5($4/$20)'), ['spacing-lost', 'no-source']);
  assert.deepEqual(claimSignals('Pro is $20/mo and $4/$20 per M tokens', { sourceUrls: ['https://x.example'] }), []);
  assert.equal(trigger.claim, 'Trigger.dev v4 bills compute at $0.10 per hour.');
  assert.deepEqual(trigger.sourceUrls, ['https://trigger.dev/pricing', 'https://trigger.dev/docs']);
  assert.deepEqual(trigger.signals, []);
  assert.equal(sdk.claimedDate, '1 Dec 2026;');
});

test('extractClaims falls back to cited prose when a report has no claims table', () => {
  const prose = REPORT.split('## **Claims**')[0] + '#### **Works cited**' + REPORT.split('#### **Works cited**')[1];
  const claims = extractClaims(prose);
  assert.equal(claims.length, 2);
  assert.equal(claims[0].origin, 'prose');
  assert.equal(claims[0].claim, 'Studios moved to credit pools (Cursor, Lovable).');
  assert.deepEqual(claims[0].sourceUrls, ['https://trigger.dev/pricing']);
  assert.ok(claims[1].claim.startsWith('Payments use x402'));
});

test('sampleClaims is reproducible for a seed and spreads the sample across categories', () => {
  const claims = ['a', 'a', 'a', 'a', 'b', 'c'].map((category, i) => ({ category, claim: `c${i}` }));
  const one = sampleClaims(claims, 3, 7);
  assert.deepEqual(one, sampleClaims(claims, 3, 7));
  assert.deepEqual(new Set(one.map((c) => c.category)), new Set(['a', 'b', 'c']));
  assert.equal(sampleClaims(claims, 50, 7).length, claims.length);
});

test('claim records start pending with the evidence fields; scoreClaims blocks release until they pass', () => {
  const records = sampleOf(REPORT);
  assert.equal(records[0].schema, CLAIM_SCHEMA);
  for (const f of ['claim', 'source_url', 'excerpt', 'source_date', 'status', 'contradictions', 'report_sha256', 'sample_from']) assert.ok(f in records[0], f);
  assert.equal(scoreOf(records).release, 'blocked');
  // Four distinct claims, so one unreachable source stays under the 30% limit.
  const four = tableReport(4);
  const sample = sampleOf(four);
  const score = (statuses) => scoreOf(sample.map((r, i) => ({ ...r, ...EVIDENCE, status: statuses[i] })), four);
  const pass = score(['verified', 'partial', 'verified', 'unreachable']);
  assert.equal(pass.release, 'pass');
  assert.equal(pass.checked, 3, 'unreachable sources are not counted as checked');
  assert.equal(pass.verifiedRate, 0.667);
  assert.equal(pass.supportedRate, 1);
  assert.equal(score(['verified', 'unreachable', 'unreachable', 'verified']).release, 'blocked', 'too few reachable sources to judge');
  const bad = score(['verified', 'contradicted', 'garbled', 'verified']);
  assert.equal(bad.release, 'blocked');
  assert.equal(bad.blocks.length, 2);
});

test('pipelineHealth fails on quarantine leaks and warns on twins, stale listings, stalled runs and a full window', () => {
  const now = Date.parse('2026-11-04T18:00:00Z');
  const h = pipelineHealth({
    now,
    corpus: [{ key: 'a/2026-11-01-leak.md', sourceId: 'X' }, { key: 'b/2026-11-04-twin.md', sourceId: 'Y' }, { key: 'c/2026-11-04-fine.md', sourceId: 'Z' }],
    quarantineKeys: ['b/2026-10-01-twin.md'], excludedIds: ['X'],
    listingMtimeMs: now - 48 * 3_600_000,
    ledger: [
      { ts: '2026-11-04T14:00:00Z', type: 'run', title: 'stuck' },
      { ts: '2026-11-04T15:00:00Z', type: 'run', title: 'ok' }, { ts: '2026-11-04T15:40:00Z', type: 'done', title: 'ok' },
      { ts: '2026-11-04T17:30:00Z', type: 'reading', sessionPct: 100, weeklyPct: 8, sessionResets: '19:18' },
    ],
    lastRun: { ts: '2026-11-04T07:00:00Z', status: 'failed:export' },
  });
  const level = Object.fromEntries(h.findings.map((f) => [f.check, f.level]));
  assert.equal(h.ok, false);
  assert.deepEqual(level, { 'quarantine-leak': 'fail', 'quarantine-twin': 'warn', 'listing-age': 'warn', 'stalled-runs': 'warn', 'usage-window': 'warn', 'last-run': 'fail' });
  assert.deepEqual(h.findings[0].detail, ['a/2026-11-01-leak.md']);
  assert.match(h.findings.find((f) => f.check === 'stalled-runs').detail, /^1 /);
});

test('an abandoned run stops blocking later runs and is never measured itself', () => {
  // The shape of a real day: two runs that never finished, then one measured run.
  const ledger = [
    { ts: '2026-11-04T14:00:00Z', type: 'reading', sessionPct: 1, weeklyPct: 3 },
    { ts: '2026-11-04T14:00:01Z', type: 'run', title: 'stalled-a' },
    { ts: '2026-11-04T14:30:00Z', type: 'run', title: 'stalled-b' },
    { ts: '2026-11-04T15:49:00Z', type: 'reading', sessionPct: 52, weeklyPct: 6 },
    { ts: '2026-11-04T16:48:00Z', type: 'run', title: 'c' },
    { ts: '2026-11-04T17:26:00Z', type: 'done', title: 'c' },
    { ts: '2026-11-04T17:26:01Z', type: 'reading', sessionPct: 100, weeklyPct: 8 },
  ];
  assert.equal(usagePlan(ledger).measuredRuns, 0, 'open runs count as overlapping');
  const closed = [...ledger,
    { ts: '2026-11-04T19:00:00Z', type: 'abandoned', title: 'stalled-a', at: '2026-11-04T14:55:00Z' },
    { ts: '2026-11-04T19:00:01Z', type: 'abandoned', title: 'stalled-b', at: '2026-11-04T14:55:00Z' }];
  const plan = usagePlan(closed);
  assert.equal(plan.measuredRuns, 1);
  assert.deepEqual(plan.costs[0], { title: 'c', domain: undefined, weekly: 2, session: 48 });
  assert.equal(pipelineHealth({ now: Date.parse('2026-11-04T20:00:00Z'), ledger: closed }).findings.some((f) => f.check === 'stalled-runs'), false);
});

test('a full-window reading stops holding launches once its local reset time has passed', () => {
  const ledger = [{ ts: new Date(2026, 10, 4, 18, 26).toISOString(), type: 'reading', sessionPct: 100, weeklyPct: 8, sessionResets: '19:18' }];
  const check = (h, m) => pipelineHealth({ now: new Date(2026, 10, 4, h, m).getTime(), ledger }).findings.find((f) => f.check.startsWith('usage')).check;
  assert.equal(check(19, 0), 'usage-window');
  assert.equal(check(19, 32), 'usage-reading');
});

// Regressions from the independent review of this change.
test('a retry under the same title pairs with its own end, and an abandon --at closes the first run', () => {
  const ledger = [
    { ts: '2026-11-04T14:00:00Z', type: 'reading', sessionPct: 0, weeklyPct: 0 },
    { ts: '2026-11-04T14:00:01Z', type: 'run', title: 't' },
    { ts: '2026-11-04T14:29:00Z', type: 'reading', sessionPct: 10, weeklyPct: 1 },
    { ts: '2026-11-04T14:30:00Z', type: 'run', title: 't' },
    { ts: '2026-11-04T15:00:00Z', type: 'done', title: 't' },
    { ts: '2026-11-04T15:01:00Z', type: 'reading', sessionPct: 55, weeklyPct: 3 },
    { ts: '2026-11-04T16:00:00Z', type: 'abandoned', title: 't', at: '2026-11-04T14:20:00Z' },
  ];
  const plan = usagePlan(ledger);
  assert.equal(plan.measuredRuns, 1);
  assert.deepEqual([plan.costs[0].session, plan.costs[0].weekly], [45, 2]);
  assert.equal(pipelineHealth({ now: Date.parse('2026-11-04T18:00:00Z'), ledger }).findings.some((f) => f.check === 'stalled-runs'), false);
});

test('a "Sources of ..." section heading does not cut off the claims table, and refs use the highest number', () => {
  const md = [
    '# R', '', '## Sources of revenue', '', 'Studios sell kits.', '',
    '| Claim | Source URL |', '| :-- | :-- |', '| Fact three3. | https://c.example/3 |', '',
    '#### Works cited', '', '> 1. A, [https://a.example](https://a.example)', '> 2. B (no link)', '> 3. C, [https://c.example/3](https://c.example/3)',
  ].join('\n');
  const [claim] = extractClaims(md);
  assert.equal(claim.claim, 'Fact three.');
  assert.deepEqual(claim.citedRefs, [{ n: 3, url: 'https://c.example/3' }]);
});

test('versioned names at the end of a clause are not read as citations', () => {
  const keep = 'Uses GPT5. Passes SOC2. Needs IPv6. Mints ERC20. Ships DeepSeekV3; React19, Node22. Python3.';
  assert.deepEqual(splitCitations(keep, 200), { text: keep, refs: [] });
});

test('an emptied or trimmed claims file cannot pass the release gate', () => {
  const recs = sampleOf(REPORT).map((r) => ({ ...r, ...EVIDENCE, status: 'verified' }));
  assert.equal(scoreOf(recs).release, 'pass');
  assert.equal(scoreOf([]).release, 'blocked');
  assert.match(scoreOf(recs.slice(0, 2)).blocks[0], /1 sampled record\(s\) missing/);
});

test('a scheduled run left "running" past the scheduler limit fails the doctor', () => {
  const now = Date.parse('2026-11-05T09:00:00Z');
  const level = (ts) => pipelineHealth({ now, lastRun: { ts, status: 'running' } }).findings.find((f) => f.check === 'last-run').level;
  assert.equal(level('2026-11-05T08:30:00Z'), 'warn');
  assert.equal(level('2026-11-05T07:00:00Z'), 'fail');
});

// Regressions from the cross-family review of 4549d23. The CLI and script tests run against a
// throwaway RESEARCH_HOME holding synthetic content only, never the private corpus.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWSH = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

function sandbox(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'research-corpus-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'cwd');
  mkdirSync(cwd);
  // A bogus remote, so a step that reached rclone by mistake fails instead of reading Drive.
  const env = { ...process.env, RESEARCH_HOME: home, RESEARCH_DRIVE_REMOTE: 'no-such-remote:', RESEARCH_TOKEN: '' };
  const cli = (...args) => spawnSync(process.execPath, [path.join(HERE, 'corpus.mjs'), ...args], { cwd, env, encoding: 'utf8' });
  return { home, cwd, env, cli };
}

// Writes a report under `key`, samples it through the CLI, and returns ways to rewrite its claims file.
function sampleIn(box, key, text, n = 3) {
  const report = path.join(box.home, 'corpus', ...key.split('/'));
  mkdirSync(path.dirname(report), { recursive: true });
  writeFileSync(report, text);
  assert.equal(box.cli('verify', 'sample', key, '--n', String(n)).status, 0);
  const claimsFile = path.join(box.home, 'verify', `${key.replace(/\.md$/, '').split('/').join('__')}.claims.jsonl`);
  const sampled = readFileSync(claimsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const write = (rows) => writeFileSync(claimsFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const fill = (status) => write(sampled.map((r) => ({ ...r, ...EVIDENCE, status })));
  return { report, claimsFile, sampled, write, fill };
}

function sampledReport(t, text = REPORT, n = 3) {
  const box = sandbox(t);
  return { ...box, ...sampleIn(box, 'd/r.md', text, n) };
}

test('verify sample writes only under RESEARCH_HOME, even when given a .jsonl corpus key', (t) => {
  const { home, cwd, cli } = sandbox(t);
  mkdirSync(path.join(home, 'corpus', 'd'), { recursive: true });
  writeFileSync(path.join(home, 'corpus', 'd', 'report.jsonl'), REPORT);
  assert.notEqual(cli('verify', 'sample', 'd/report.jsonl').status, 0);
  assert.equal(existsSync(path.join(cwd, 'd')), false, 'nothing is written beside the checkout');
});

test('a checked status without its evidence cannot pass the release gate', () => {
  const recs = sampleOf(REPORT);
  const gate = (patch) => scoreOf(recs.map((r) => ({ ...r, ...patch })));
  const bare = gate({ status: 'verified' });
  assert.equal(bare.release, 'blocked');
  assert.match(bare.blocks.join(' '), /3 checked claim\(s\) lack evidence/);
  assert.equal(gate({ ...EVIDENCE, status: 'verified', excerpt: ' ' }).release, 'blocked', 'a verified claim quotes its source');
  assert.equal(gate({ ...EVIDENCE, status: 'verified', checked_at: 'yesterday' }).release, 'blocked', 'checked_at is a date');
  assert.equal(gate({ ...EVIDENCE, status: 'verified', source_date: null }).release, 'pass');
  assert.ok(!gate({ ...EVIDENCE, status: 'garbled', excerpt: null }).blocks.some((b) => /evidence/.test(b)), 'a garbled claim has nothing to quote');
});

test('duplicate records neither complete a sample nor dilute its failure share', () => {
  const [one] = sampleOf(REPORT);
  const verified = { ...one, ...EVIDENCE, status: 'verified' };
  const padded = scoreOf(Array.from({ length: 10 }, () => verified));
  assert.equal(padded.release, 'blocked');
  assert.match(padded.blocks.join(' '), /2 sampled record\(s\) missing/);
  assert.match(padded.blocks.join(' '), /9 duplicate record\(s\)/);
  // Five distinct claims, two unsupported (40%), padded with copies of a verified one (2/13 = 15%).
  const text = tableReport(5);
  const five = sampleOf(text).map((r, i) => ({ ...r, ...EVIDENCE, status: i < 3 ? 'verified' : 'unsupported' }));
  assert.equal(scoreOf([...five, ...Array.from({ length: 8 }, () => five[0])], text).release, 'blocked');
});

test('a verdict does not outlive its report: a changed body or a deleted report blocks the score', (t) => {
  const { report, fill, cli } = sampledReport(t);
  fill('verified');
  assert.equal(cli('verify', 'score', 'd/r.md').status, 0);
  writeFileSync(report, REPORT.replace('kind: deep-research', 'kind: deep-research\nexported: 2026-11-05T00:00:00Z'));
  assert.equal(cli('verify', 'score', 'd/r.md').status, 0, 'a front matter rewrite is not a report change');
  writeFileSync(report, REPORT.replace('$0.10 per hour', '$0.20 per hour'));
  const changed = cli('verify', 'score', 'd/r.md');
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /report changed since the sample was drawn/);
  rmSync(report);
  const gone = cli('verify', 'score', 'd/r.md');
  assert.equal(gone.status, 1);
  assert.match(gone.stdout, /report is missing from the corpus/);
  // The pure gate holds the same rule for any caller.
  const recs = claimRecords(extractClaims(REPORT), { reportKey: 'd/r.md', sampledAt: 'now', seed: 1 }).map((r) => ({ ...r, ...EVIDENCE, status: 'verified' }));
  assert.equal(scoreOf(recs).release, 'blocked', 'a sample without a digest cannot be tied to the report');
});

test('verify score exits 1 when the release is blocked, so a shell gate stops', (t) => {
  const { fill, cli } = sampledReport(t);
  fill('contradicted');
  const res = cli('verify', 'score', 'd/r.md');
  assert.match(res.stdout, /"release": "blocked"/);
  assert.equal(res.status, 1);
});

test('usage done and abandon refuse a title with no open run, and run and done require a title', (t) => {
  const { home, cli } = sandbox(t);
  const rows = () => (existsSync(path.join(home, 'gemini-usage.jsonl'))
    ? readFileSync(path.join(home, 'gemini-usage.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length : 0);
  assert.notEqual(cli('usage', 'done').status, 0, 'done needs a title');
  assert.notEqual(cli('usage', 'done', '--title', 'nope').status, 0);
  assert.notEqual(cli('usage', 'abandon', '--title', 'nope').status, 0);
  assert.notEqual(cli('usage', 'run', '--domain', 'solana').status, 0, 'run needs a title, or nothing can close it');
  assert.equal(rows(), 0, 'a refused command writes nothing');
  assert.equal(cli('usage', 'run', '--domain', 'solana', '--title', 'real').status, 0);
  assert.notEqual(cli('usage', 'done', '--title', 'typo').status, 0);
  assert.equal(cli('usage', 'done', '--title', 'real').status, 0);
  assert.notEqual(cli('usage', 'done', '--title', 'real').status, 0, 'a closed run is not closed twice');
  assert.equal(rows(), 2);
  // The retry window matches runEnd: an abandon --at inside the first run closes the first run only.
  const retry = [
    { ts: '2026-11-04T14:00:00Z', type: 'run', title: 't' },
    { ts: '2026-11-04T14:30:00Z', type: 'run', title: 't' },
    { ts: '2026-11-04T15:00:00Z', type: 'done', title: 't' },
  ];
  assert.equal(openRunFor(retry, 't', '2026-11-04T14:20:00Z')?.ts, '2026-11-04T14:00:00Z');
  assert.equal(openRunFor(retry, 't', '2026-11-04T16:00:00Z'), null);
});

test('runs that share the interval between two readings are not each charged the combined rise', () => {
  const ledger = [
    { ts: '2026-11-04T10:00:00Z', type: 'reading', sessionPct: 0, weeklyPct: 0 },
    { ts: '2026-11-04T10:01:00Z', type: 'run', title: 'a' },
    { ts: '2026-11-04T10:20:00Z', type: 'done', title: 'a' },
    { ts: '2026-11-04T10:30:00Z', type: 'run', title: 'b' },
    { ts: '2026-11-04T10:50:00Z', type: 'done', title: 'b' },
    { ts: '2026-11-04T11:00:00Z', type: 'reading', sessionPct: 20, weeklyPct: 4 },
  ];
  assert.equal(usagePlan(ledger).measuredRuns, 0);
  assert.equal(usagePlan(ledger).weeklyPerRun, null);
});

test('a run across a meter reset is not measured, so no cost is negative or understated', () => {
  const across = (before, after) => usagePlan([
    { ts: '2026-11-04T10:00:00Z', type: 'reading', ...before },
    { ts: '2026-11-04T10:01:00Z', type: 'run', title: 'x' },
    { ts: '2026-11-04T10:40:00Z', type: 'done', title: 'x' },
    { ts: '2026-11-04T10:41:00Z', type: 'reading', ...after },
  ]);
  const window = across({ sessionPct: 95, weeklyPct: 40 }, { sessionPct: 1, weeklyPct: 42 });
  assert.equal(window.measuredRuns, 0);
  assert.deepEqual(window.costs, []);
  assert.equal(across({ sessionPct: 10, weeklyPct: 98 }, { sessionPct: 30, weeklyPct: 3 }).measuredRuns, 0, 'weekly reset');
  // The window reset time passed mid-run, yet the meter still rose: the rise is not this run's cost.
  const local = (h, m) => new Date(2026, 10, 4, h, m).toISOString();
  const crossed = usagePlan([
    { ts: local(18, 0), type: 'reading', sessionPct: 60, weeklyPct: 10, sessionResets: '18:30' },
    { ts: local(18, 5), type: 'run', title: 'y' },
    { ts: local(18, 50), type: 'done', title: 'y' },
    { ts: local(18, 55), type: 'reading', sessionPct: 70, weeklyPct: 12 },
  ]);
  assert.equal(crossed.measuredRuns, 0);
});

test('the daily task keeps a failed refresh failed after the brief succeeds', { skip: !PWSH && 'pwsh not installed' }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'research-corpus-task-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The exact command line register-daily.ps1 hands to Task Scheduler, run against stub steps.
  const line = readFileSync(path.join(HERE, 'register-daily.ps1'), 'utf8').match(/^\$script = .*$/m)[0];
  writeFileSync(path.join(dir, 'refresh-fail.ps1'), 'exit 1\n');
  writeFileSync(path.join(dir, 'refresh-ok.ps1'), "'ok'\n");
  writeFileSync(path.join(dir, 'brief.mjs'), '\n');
  const exitFor = (refresh) => {
    const harness = path.join(dir, `harness-${refresh}`);
    writeFileSync(harness, [
      `$run = '${path.join(dir, refresh)}'`, `$cli = '${path.join(dir, 'brief.mjs')}'`, `$log = '${path.join(dir, 'daily.log')}'`,
      line, 'pwsh -NoProfile -Command $script', 'exit $LASTEXITCODE',
    ].join('\n'));
    return spawnSync('pwsh', ['-NoProfile', '-File', harness], { encoding: 'utf8' }).status;
  };
  assert.equal(exitFor('refresh-fail.ps1'), 1);
  assert.equal(exitFor('refresh-ok.ps1'), 0);
});

test('an invocation skipped on the lock keeps the running record, so doctor still fails a killed run', { skip: !PWSH && 'pwsh not installed' }, (t) => {
  const { home, env } = sandbox(t);
  const runs = path.join(home, 'runs');
  mkdirSync(runs);
  writeFileSync(path.join(runs, 'scheduled-run.lock'), '4242');
  const running = { ts: '2026-11-05T07:15:00.000Z', status: 'running', steps: [] };
  writeFileSync(path.join(runs, 'last-run.json'), JSON.stringify(running));
  const res = spawnSync('pwsh', ['-NoProfile', '-File', path.join(HERE, 'scheduled-run.ps1')], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const lastRun = JSON.parse(readFileSync(path.join(runs, 'last-run.json'), 'utf8'));
  assert.deepEqual(lastRun, running);
  const doctor = pipelineHealth({ now: Date.parse('2026-11-05T09:00:00Z'), lastRun }).findings.find((f) => f.check === 'last-run');
  assert.equal(doctor.level, 'fail');
});

// Regressions from the cross-family review of a5afa26.
test('a claims file must hold the sample redrawn from the report: no copied rows, no lowered size', (t) => {
  const { sampled, write, cli } = sampledReport(t);
  const verified = sampled.map((r) => ({ ...r, ...EVIDENCE, status: 'verified' }));
  write(verified);
  assert.equal(cli('verify', 'score', 'd/r.md').status, 0);
  // One verified row copied over the others, each keeping its own id.
  write(verified.map((r) => ({ ...verified[0], id: r.id })));
  const copied = cli('verify', 'score', 'd/r.md');
  assert.equal(copied.status, 1);
  assert.match(copied.stdout, /2 record\(s\) differ from the sample redrawn from the report/);
  // A trimmed file that lowers sample_size to match.
  write([{ ...verified[0], sample_size: 1 }]);
  const trimmed = cli('verify', 'score', 'd/r.md');
  assert.equal(trimmed.status, 1);
  assert.match(trimmed.stdout, /below the release minimum of 3/);
});

test('verify score <key> judges only that report, never a sidecar describing another one', (t) => {
  const box = sandbox(t);
  const a = sampleIn(box, 'd/a.md', REPORT);
  const b = sampleIn(box, 'd/b.md', tableReport(3));
  b.fill('verified');
  assert.equal(box.cli('verify', 'score', 'd/b.md').status, 0);
  writeFileSync(a.claimsFile, readFileSync(b.claimsFile));
  const swapped = box.cli('verify', 'score', 'd/a.md');
  assert.equal(swapped.status, 1);
  assert.match(swapped.stdout, /describe a report other than d\/a\.md/);
  rmSync(a.report);
  assert.equal(box.cli('verify', 'score', 'd/a.md').status, 1, 'with A deleted, B\'s verdict still does not pass for A');
});

test('the report digest covers provenance front matter and exempts only pipeline timestamps', (t) => {
  const withProvenance = REPORT.replace('kind: deep-research', 'kind: deep-research\nsource_id: drive-file-1\nverification: unverified-ai-synthesis\nexported: 2026-11-04T00:00:00Z');
  const { report, fill, cli } = sampledReport(t, withProvenance);
  fill('verified');
  assert.equal(cli('verify', 'score', 'd/r.md').status, 0);
  writeFileSync(report, withProvenance.replace('verification: unverified-ai-synthesis', 'verification: measured-from-provider-api'));
  assert.equal(cli('verify', 'score', 'd/r.md').status, 1, 'a changed trust label invalidates the verdict');
  writeFileSync(report, withProvenance.replace('source_id: drive-file-1', 'source_id: drive-file-2'));
  assert.equal(cli('verify', 'score', 'd/r.md').status, 1, 'a different source document invalidates the verdict');
  writeFileSync(report, withProvenance.replace('exported: 2026-11-04T00:00:00Z', 'exported: 2026-11-05T00:00:00Z'));
  assert.equal(cli('verify', 'score', 'd/r.md').status, 0, 'a re-export timestamp alone does not');
  assert.equal(reportDigest(withProvenance.replace('kind: deep-research', 'kind: gemini-canvas')) === reportDigest(withProvenance), false);
});

test('a verified, partial or contradicted verdict needs a source the report cites', (t) => {
  // A fourth table row with no URL and no citation number: extracted, flagged no-source.
  const unsourced = REPORT.replace('\n\n#### **Works cited**', '\n| **Runtimes** | Agents never need a source. |  | 2026 |\n\n#### **Works cited**');
  const { sampled, write, cli } = sampledReport(t, unsourced, 4);
  assert.ok(sampled.some((r) => r.signals.includes('no-source') && r.source_url === null));
  write(sampled.map((r) => ({ ...r, ...EVIDENCE, status: 'verified' })));
  const res = cli('verify', 'score', 'd/r.md');
  assert.equal(res.status, 1);
  assert.match(res.stdout, /1 verified, partial or contradicted claim\(s\) have no source URL the report cites/);
  // Calling that claim unsupported is honest and is not an attribution failure.
  const honest = scoreOf(sampled.map((r) => ({ ...r, ...EVIDENCE, status: r.source_url ? 'verified' : 'unsupported' })), unsourced);
  assert.ok(!honest.blocks.some((b) => /no source URL/.test(b)));
});

test('a reading inside the interval that shows a fall or announces a reset excludes the run', () => {
  const at = (h, m) => new Date(2026, 10, 4, h, m).toISOString();
  // The reviewer's case: the 10:00 reading announces a weekly reset at 10:30; the 10:31 reading shows it.
  const weekly = usagePlan([
    { ts: at(10, 0), type: 'reading', sessionPct: 10, weeklyPct: 2, sessionResets: '14:00', weeklyResets: '4 Nov 10:30' },
    { ts: at(10, 5), type: 'run', title: 'x' },
    { ts: at(10, 31), type: 'reading', sessionPct: 15, weeklyPct: 0, sessionResets: '14:00', weeklyResets: '11 Nov 10:30' },
    { ts: at(10, 45), type: 'done', title: 'x' },
    { ts: at(10, 50), type: 'reading', sessionPct: 20, weeklyPct: 3, sessionResets: '14:00', weeklyResets: '11 Nov 10:30' },
  ]);
  assert.equal(weekly.measuredRuns, 0);
  // An intermediate session fall with no reset times recorded at all.
  const fall = usagePlan([
    { ts: at(11, 0), type: 'reading', sessionPct: 80, weeklyPct: 10 },
    { ts: at(11, 5), type: 'run', title: 'y' },
    { ts: at(11, 20), type: 'reading', sessionPct: 2, weeklyPct: 11 },
    { ts: at(11, 40), type: 'done', title: 'y' },
    { ts: at(11, 45), type: 'reading', sessionPct: 90, weeklyPct: 12 },
  ]);
  assert.equal(fall.measuredRuns, 0);
  // A weekly reset announced for a later week leaves the run measurable.
  const later = usagePlan([
    { ts: at(12, 0), type: 'reading', sessionPct: 10, weeklyPct: 2, weeklyResets: '10 Nov 15:18' },
    { ts: at(12, 5), type: 'run', title: 'z' },
    { ts: at(12, 40), type: 'done', title: 'z' },
    { ts: at(12, 45), type: 'reading', sessionPct: 20, weeklyPct: 3, weeklyResets: '10 Nov 15:18' },
  ]);
  assert.equal(later.measuredRuns, 1);
});
