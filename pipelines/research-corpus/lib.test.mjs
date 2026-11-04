import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { briefMarkdown, catalogMarkdown, classify, corpusKey, dueDomains, frontMatter, importKey, localFrontMatter, routeDomain, staleDriveKeys, usageToday } from './lib.mjs';

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

test('importKey keeps two README files from different repos apart', () => {
  const a = importKey({ domain: 'business-strategy', sourcePath: String.raw`C:\r\alpha\README.md`, repoRoot: 'C:/r/alpha' });
  const b = importKey({ domain: 'business-strategy', sourcePath: 'C:/r/beta/README.md', repoRoot: 'C:/r/beta' });
  assert.equal(a, 'business-strategy/estate-alpha-readme.md');
  assert.equal(b, 'business-strategy/estate-beta-readme.md');
});

test('importKey separates same-named files in different folders of one repo', () => {
  const root = 'C:/r/alpha';
  const top = importKey({ domain: 'marketing', sourcePath: `${root}/README.md`, repoRoot: root });
  const nested = importKey({ domain: 'marketing', sourcePath: `${root}/docs/README.md`, repoRoot: root });
  assert.notEqual(top, nested);
});

test('importKey outside a git repo falls back to the parent folder name', () => {
  assert.equal(importKey({ domain: 'marketing', sourcePath: 'C:/notes/brief.md', repoRoot: null }), 'marketing/estate-notes-brief.md');
});

test('estate briefs and Arcanea docs route instead of landing in unrouted', () => {
  const cases = [
    ['Creator-Observatory-Brief-2026-11-04', 'marketing'],
    ['Dream100-Operating-Plan-2026-11-01', 'marketing'],
    ['Portfolio-Audit-2026-10-30', 'business-strategy'],
    ['Constellation Weekly Brief — 2026-09-07', 'business-strategy'],
    ['[CANONICAL] Media-Intelligence-Evidence-Loop-2026-10-27', 'music-media'],
    ['THE-ARCANEAN-CODE-v2', 'arcanea'],
    ['ARCANEA-COMMAND-CENTER (4)', 'arcanea'],
  ];
  for (const [title, domain] of cases) assert.equal(routeDomain(title, domains), domain, title);
});

test('staleDriveKeys keeps included exports and flags excluded, re-routed or vanished ones', () => {
  const inventory = classify([
    doc('keep', 'Cloudflare and Vercel Architecture Hub', 364108),
    doc('gone', 'Personal journal reflections', 90000),
  ], { domains });
  const keep = corpusKey(inventory.find((e) => e.id === 'keep'));
  const driveKeys = [keep, 'ai-models-platforms/2026-10-28-personal-journal-reflections.md', 'unrouted/2026-10-28-cloudflare-and-vercel-architecture-hub.md'];
  assert.deepEqual(staleDriveKeys({ driveKeys, inventory }), [
    'ai-models-platforms/2026-10-28-personal-journal-reflections.md',
    'unrouted/2026-10-28-cloudflare-and-vercel-architecture-hub.md',
  ]);
});

test('staleDriveKeys with nothing stale returns an empty list', () => {
  const inventory = classify([doc('a', 'Cloudflare and Vercel Architecture Hub', 364108)], { domains });
  assert.deepEqual(staleDriveKeys({ driveKeys: [corpusKey(inventory[0])], inventory }), []);
});
