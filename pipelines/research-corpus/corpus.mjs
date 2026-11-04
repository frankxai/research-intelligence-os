#!/usr/bin/env node
// Research corpus CLI: Google Drive research -> private corpus -> R2 -> Cloudflare AI Search,
// plus a session brief and a Gemini Deep Research usage ledger.
//
//   node corpus.mjs list                 rclone lists Drive root Docs -> drive-listing.json
//   node corpus.mjs classify [listing]   listing -> inventory.json (kind, domain, include)
//   node corpus.mjs export               rclone exports included Docs as markdown + front matter
//   node corpus.mjs import <f.md>... --domain <id> [--kind k]   local or repo docs, with path + commit provenance
//   node corpus.mjs push                 uploads changed corpus/*.md to R2, then asks the Worker to sync
//   node corpus.mjs sync | status        Worker: copy R2 into AI Search | indexing state
//   node corpus.mjs search "<q>" [--domain id]   ranked passages from the Worker
//   node corpus.mjs ask "<q>" [--domain id]      cited answer from the Worker
//   node corpus.mjs brief                writes the session brief from live model catalogs
//   node corpus.mjs queue                domains whose newest report is past its window
//   node corpus.mjs usage snapshot --remaining N [--note "..."]   record a reading from the Gemini app
//   node corpus.mjs usage run --domain <id> --title "<topic>"     log a Deep Research run
//   node corpus.mjs usage reading --session P --weekly P [...]   record the Usage limits page (percent meter)
//   node corpus.mjs usage done --title "<topic>"                 mark a run finished (pair with a reading after it)
//   node corpus.mjs usage plan                                   measured % cost per run, runs left this window/week
//   node corpus.mjs usage show
//
// All private state lives in RESEARCH_HOME (default ~/.starlight/research), never in this repo.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, renameSync, statSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PERSONAL_PATTERNS, briefMarkdown, catalogMarkdown, classify, corpusKey, dueDomains, frontMatter,
  localFrontMatter, slugify, usageToday, usagePlan, evidenceStats, chunkMarkdown, bm25Rank,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.RESEARCH_HOME || path.join(homedir(), '.starlight', 'research');
const BRIEF_PATH = process.env.STARLIGHT_BRIEF || path.join(homedir(), '.starlight', 'brief', 'session-brief.md');
const RCLONE_REMOTE = process.env.RESEARCH_DRIVE_REMOTE || 'gdrive:';
const BUCKET = process.env.RESEARCH_BUCKET || 'starlight-research-corpus';
const INSTANCE = process.env.RESEARCH_AI_SEARCH || 'starlight-research';
const GATEWAY_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';
const WORKER_URL = process.env.RESEARCH_URL || 'https://starlight-research.frankxai.workers.dev';
// `npx --no-install` breaks whenever the pinned wrangler version is not cached; the installed binary does not.
const WRANGLER = process.env.RESEARCH_WRANGLER || 'wrangler';

const P = {
  listing: path.join(HOME, 'drive-listing.json'),
  inventory: path.join(HOME, 'inventory.json'),
  exclude: path.join(HOME, 'exclude.txt'),
  excludeIds: path.join(HOME, 'exclude-ids.txt'),
  corpus: path.join(HOME, 'corpus'),
  usage: path.join(HOME, 'gemini-usage.jsonl'),
  manifest: path.join(HOME, 'push-manifest.json'),
  workerSecrets: path.join(HOME, 'worker-secrets.env'),
};

function workerToken() {
  if (process.env.RESEARCH_TOKEN) return process.env.RESEARCH_TOKEN;
  if (!existsSync(P.workerSecrets)) return null;
  const line = readFileSync(P.workerSecrets, 'utf8').split(/\r?\n/).find((l) => l.startsWith('RESEARCH_TOKEN='));
  return line ? line.slice('RESEARCH_TOKEN='.length).trim() : null;
}

async function worker(route, body = {}) {
  const token = workerToken();
  if (!token) die(`no RESEARCH_TOKEN (env or ${P.workerSecrets})`);
  const res = await fetch(`${WORKER_URL}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const out = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) die(`${route} failed (${res.status}): ${out.error ?? JSON.stringify(out)}`);
  return out;
}

// Private routing rules (brand and estate vocabulary) live beside the corpus, never in this public repo.
// They are tried first, so an owner can route their own titles without editing the shared list.
const localDomains = existsSync(path.join(HOME, 'domains.local.json'))
  ? JSON.parse(readFileSync(path.join(HOME, 'domains.local.json'), 'utf8')).domains
  : [];
const domains = [...localDomains, ...JSON.parse(readFileSync(path.join(HERE, 'domains.json'), 'utf8')).domains];

function die(msg, code = 1) { console.error(msg); process.exit(code); }
function readJson(file, fallback) { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; }

function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

// npx and rclone resolve to .cmd shims on Windows, which Node only spawns through a shell.
// Arguments are quoted and stripped of quote characters so a search query cannot break out.
function run(cmd, args, { allowFail = false } = {}) {
  const win = process.platform === 'win32';
  const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  const res = win
    ? spawnSync([cmd, ...args.map((a) => `"${String(a).replace(/["%^&|<>]/g, '')}"`)].join(' '), { ...opts, shell: true })
    : spawnSync(cmd, args, opts);
  if (res.status !== 0 && !allowFail) die(`${cmd} ${args[0]} failed (${res.status}):\n${(res.stderr || res.stdout || '').slice(0, 2000)}`);
  return res;
}

function jsonFrom(text) {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in output');
  return JSON.parse(text.slice(start));
}

function personalPatterns() {
  const extra = existsSync(P.exclude)
    ? readFileSync(P.exclude, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];
  return [...DEFAULT_PERSONAL_PATTERNS, ...extra];
}

function cmdList() {
  const depth = String(flag('depth') || process.env.RESEARCH_DRIVE_DEPTH || '3');
  const res = run('rclone', ['lsjson', RCLONE_REMOTE, '--files-only', '--max-depth', depth, '-M', '--drive-export-formats', 'md']);
  const files = JSON.parse(res.stdout).map((f) => ({
    id: f.ID,
    title: path.basename(f.Path || f.Name).replace(/\.md$/, ''),
    drivePath: f.Path || f.Name,
    mimeType: f.MimeType === 'text/markdown' ? 'application/vnd.google-apps.document' : f.MimeType,
    createdTime: f.Metadata?.btime || f.ModTime,
    modifiedTime: f.ModTime,
    fileSize: f.Size,
  }));
  writeAtomic(P.listing, JSON.stringify(files, null, 2));
  console.log(`listed ${files.length} files (max-depth ${depth}) -> ${P.listing}`);
}

function cmdClassify() {
  const source = process.argv[3] || P.listing;
  const raw = readJson(source, null);
  if (!raw) die(`no listing at ${source}; run "list" first or pass a JSON file`);
  const files = Array.isArray(raw) ? raw : raw.files;
  const blocked = new Set(existsSync(P.excludeIds) ? readFileSync(P.excludeIds, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
  const inventory = classify(files, { domains, personalPatterns: personalPatterns() })
    .map((e) => (blocked.has(e.id) ? { ...e, kind: 'sensitive', domain: null, include: false } : e));
  writeAtomic(P.inventory, JSON.stringify(inventory, null, 2));
  const count = (pred) => inventory.filter(pred).length;
  console.log(JSON.stringify({
    inventory: P.inventory,
    total: inventory.length,
    deepResearch: count((e) => e.kind === 'deep-research' && e.include),
    geminiCanvas: count((e) => e.kind === 'gemini-canvas' && e.include),
    personalExcluded: count((e) => e.kind === 'personal'),
    sensitiveExcluded: count((e) => e.kind === 'sensitive'),
    supersededExcluded: count((e) => e.kind === 'superseded'),
    duplicates: count((e) => e.duplicateOf),
    unrouted: count((e) => e.include && e.domain === 'unrouted'),
  }, null, 2));
}

function cmdExport() {
  const inventory = readJson(P.inventory, null) || die('no inventory; run "classify" first');
  const exportedAt = new Date().toISOString();
  const staging = path.join(HOME, 'staging');
  let done = 0;
  for (const entry of inventory.filter((e) => e.include)) {
    const target = path.join(P.corpus, corpusKey(entry));
    if (existsSync(target) && statSync(target).mtime >= new Date(entry.modifiedTime)) continue;
    mkdirSync(staging, { recursive: true });
    const tmp = path.join(staging, `${entry.id}.md`);
    run('rclone', ['backend', 'copyid', RCLONE_REMOTE, entry.id, tmp, '--drive-export-formats', 'md']);
    const body = readFileSync(tmp, 'utf8');
    writeAtomic(target, frontMatter(entry, exportedAt, evidenceStats(body)) + body);
    done += 1;
  }
  console.log(`exported ${done} changed document(s) -> ${P.corpus}`);
}

// The commit is recorded only when the file is unmodified at HEAD; a dirty file is a draft.
function gitCommitFor(file) {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const dirty = spawnSync('git', ['-C', dir, 'status', '--porcelain', '--', name], { encoding: 'utf8' });
  if (dirty.status !== 0 || dirty.stdout.trim()) return null;
  const log = spawnSync('git', ['-C', dir, 'log', '-1', '--format=%H', '--', name], { encoding: 'utf8' });
  return log.status === 0 ? log.stdout.trim() || null : null;
}

function cmdImport() {
  const files = process.argv.slice(3).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
  const domain = flag('domain');
  const kind = flag('kind') || 'estate-doc';
  if (!files.length || !domains.some((d) => d.id === domain)) {
    die(`usage: import <file.md>... --domain <${domains.map((d) => d.id).join('|')}> [--kind estate-doc]`);
  }
  const importedAt = new Date().toISOString();
  for (const file of files.map((f) => path.resolve(f))) {
    const text = readFileSync(file, 'utf8');
    const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(file, '.md')).trim();
    const modified = statSync(file).mtime.toISOString();
    const commit = gitCommitFor(file);
    const target = path.join(P.corpus, domain, `estate-${slugify(path.basename(file, '.md'))}.md`);
    writeAtomic(target, localFrontMatter({ title, sourcePath: file, commit, domain, kind, modified }, importedAt) + text);
    console.log(`${commit ? 'committed' : 'DRAFT    '} ${path.relative(P.corpus, target)}`);
  }
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.md') ? [path.join(dir, d.name)] : []);
}

async function cmdPush() {
  const manifest = readJson(P.manifest, {});
  let pushed = 0;
  for (const file of walk(P.corpus)) {
    const key = path.relative(P.corpus, file).split(path.sep).join('/');
    const mtime = statSync(file).mtimeMs;
    if (manifest[key] === mtime) continue;
    run(WRANGLER, ['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file,
      '--content-type', 'text/markdown; charset=utf-8', '--remote']);
    manifest[key] = mtime;
    pushed += 1;
  }
  writeAtomic(P.manifest, JSON.stringify(manifest, null, 2));
  console.log(`pushed ${pushed} file(s) to r2://${BUCKET}`);
  if (pushed && workerToken()) console.log(JSON.stringify(await worker('/sync'), null, 2));
}

function positional() {
  return process.argv.slice(3).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--')).join(' ');
}

async function cmdSearch() {
  const query = positional();
  if (!query) die('usage: corpus.mjs search "<question>" [--domain <id>] [--limit N] [--local]');
  if (flag('local') !== undefined || !existsSync(P.workerSecrets)) return localSearch(query);
  const out = await worker('/search', { query, domain: flag('domain'), limit: Number(flag('limit') || 8) });
  for (const p of out.passages) console.log(`\n[${p.score}] ${p.key}\n${p.text.trim().slice(0, 600)}`);
  if (!out.passages.length) console.log('no passages (is the corpus indexed? run: corpus.mjs status)');
}

// BM25 over the local corpus: usable without the Worker, and the baseline a vector index must beat.
function listCorpusFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? listCorpusFiles(p) : d.name.endsWith('.md') ? [p] : [];
  });
}

function buildPassages({ wanted, scope } = {}) {
  const triage = readTriage();
  const passages = [];
  for (const file of listCorpusFiles(P.corpus)) {
    const rel = path.relative(P.corpus, file).split(path.sep).join('/');
    if (wanted && !rel.startsWith(`${wanted}/`)) continue;
    // A reviewed document is searchable only in its own namespace; unreviewed ones stay visible.
    const verdict = triage.get(rel);
    if (scope && verdict?.scope !== scope) continue;
    // Without --scope the default namespaces are research and decisions; creative and private-ops
    // material is searched only when asked for, so manuscripts never answer a business question.
    if (!scope && ['creative', 'private-ops'].includes(verdict?.scope)) continue;
    if (verdict?.vectorize === 'no') continue;
    const { meta, chunks } = chunkMarkdown(readFileSync(file, 'utf8'));
    for (const c of chunks) passages.push({ ...c, key: rel, evidence: meta.evidence ?? 'n/a', verification: meta.verification ?? '?' });
  }
  return passages;
}

function localSearch(query) {
  const passages = buildPassages({ wanted: flag('domain'), scope: flag('scope') });
  const hits = bm25Rank(passages, query, { limit: Number(flag('limit') || 8) });
  for (const h of hits) console.log(`${String.fromCharCode(10)}[${h.score}] ${h.key} > ${h.heading} (${h.evidence}, ${h.verification})${String.fromCharCode(10)}${h.text.slice(0, 600)}`);
  if (!hits.length) console.log(`no local passages (${passages.length} indexed)`);
}

// Retrieval evaluation: questions live in ~/.starlight/research/eval/questions.json as
// [{ "q": "...", "expect": ["substring of the right document key"], "scope": "optional namespace" }]. Reports hit@1, hit@5 and
// MRR for the local BM25 baseline; any vector or hybrid index must beat these on the same file.
function cmdEval() {
  const file = flag('file') || path.join(HOME, 'eval', 'questions.json');
  const questions = readJson(file, null) || die(`no questions at ${file}`);
  const byScope = new Map();
  const passagesFor = (scope) => { const k = scope ?? flag('scope') ?? ''; if (!byScope.has(k)) byScope.set(k, buildPassages({ scope: k || undefined })); return byScope.get(k); };
  let h1 = 0; let h5 = 0; let rr = 0;
  const misses = [];
  for (const { q, expect, scope } of questions) {
    const ranked = bm25Rank(passagesFor(scope), q, { limit: 50 });
    const keys = [];
    for (const p of ranked) if (!keys.includes(p.key)) keys.push(p.key);
    const pos = keys.findIndex((k) => expect.some((e) => k.includes(e)));
    if (pos === 0) h1 += 1;
    if (pos >= 0 && pos < 5) h5 += 1;
    if (pos >= 0) rr += 1 / (pos + 1); else misses.push(q);
  }
  const n = questions.length;
  console.log(JSON.stringify({ questions: n, passages: passagesFor().length, hitAt1: +(h1 / n).toFixed(3), hitAt5: +(h5 / n).toFixed(3), mrr: +(rr / n).toFixed(3), misses }, null, 2));
}

function cmdAudit() {
  const inv = readJson(P.inventory, null) || die('no inventory; run "classify" first');
  const rows = [];
  for (const file of listCorpusFiles(P.corpus)) {
    const { meta } = chunkMarkdown(readFileSync(file, 'utf8'));
    rows.push({ key: path.relative(P.corpus, file).split(path.sep).join('/'), kind: meta.kind, domain: meta.domain, evidence: meta.evidence ?? 'unknown', urls: Number(meta.source_urls ?? 0) });
  }
  const tally = (f) => rows.reduce((a, r) => ((a[f(r)] = (a[f(r)] ?? 0) + 1), a), {});
  const stale = rows.filter((r) => !inv.some((e) => e.include && corpusKey(e) === r.key));
  const out = {
    exported: rows.length, byKind: tally((r) => r.kind), byDomain: tally((r) => r.domain), byEvidence: tally((r) => `${r.kind}/${r.evidence}`),
    uncitedDeepResearch: rows.filter((r) => r.kind === 'deep-research' && r.evidence === 'uncited').map((r) => r.key),
    notInInventory: stale.map((r) => r.key),
  };
  writeAtomic(path.join(HOME, 'audit.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

// Removes local derived copies of documents the inventory no longer includes (reclassified as
// sensitive or superseded). Drive originals are never touched; export recreates anything needed.
function cmdPrune() {
  const inv = readJson(P.inventory, null) || die('no inventory; run "classify" first');
  const keep = new Set(inv.filter((e) => e.include).map(corpusKey));
  let removed = 0;
  for (const file of listCorpusFiles(P.corpus)) {
    if (!keep.has(path.relative(P.corpus, file).split(path.sep).join('/'))) { rmSync(file); removed += 1; }
  }
  console.log(`pruned ${removed} local file(s) no longer in the inventory`);
}

// Triage verdicts (triage-*.jsonl, written by reviewers) decide what is indexed and in which
// namespace. "no" documents are moved to a local quarantine folder, never deleted, and their Drive
// ids are recorded so a later export cannot bring them back.
function readTriage() {
  const map = new Map();
  const dir = path.join(HOME, 'triage');
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir).filter((n) => /^triage-.*[.]jsonl$/.test(n))) {
    for (const line of readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean)) {
      try { const r = JSON.parse(line); map.set(r.key, r); } catch { /* skip a malformed line */ }
    }
  }
  return map;
}

function cmdTriage() {
  const sub = process.argv[3] || 'summary';
  const triage = readTriage();
  if (sub === 'summary') {
    const tally = (f) => [...triage.values()].reduce((a, r) => ((a[f(r)] = (a[f(r)] ?? 0) + 1), a), {});
    console.log(JSON.stringify({ reviewed: triage.size, byTier: tally((r) => r.tier), byVectorize: tally((r) => r.vectorize), byScope: tally((r) => r.scope), byAuthority: tally((r) => r.authority) }, null, 2));
    return;
  }
  if (sub !== 'apply') die('usage: triage summary|apply');
  const quarantine = path.join(HOME, 'quarantine');
  const ids = existsSync(P.excludeIds) ? readFileSync(P.excludeIds, 'utf8') : '';
  let moved = 0;
  for (const r of triage.values()) {
    const src = path.join(P.corpus, r.key);
    if (r.vectorize !== 'no' || !existsSync(src)) continue;
    const id = (readFileSync(src, 'utf8').match(/^source_id: (.+)$/m) || [])[1];
    if (id && !ids.includes(id)) appendFileSync(P.excludeIds, `${id}\n`);
    const dest = path.join(quarantine, r.key);
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(src, dest);
    moved += 1;
  }
  console.log(`quarantined ${moved} document(s) to ${quarantine}; ids recorded in ${P.excludeIds}`);
}

async function cmdAsk() {
  const question = positional();
  if (!question) die('usage: corpus.mjs ask "<question>" [--domain <id>]');
  const out = await worker('/ask', { question, domain: flag('domain') });
  console.log(`${out.answer}\n\nSources (${out.model}):`);
  for (const s of out.sources) console.log(`  [${s.score}] ${s.key}`);
}

async function cmdStatus() {
  console.log(JSON.stringify(await worker('/status'), null, 2));
}

async function cmdSync() {
  console.log(JSON.stringify(await worker('/sync'), null, 2));
}

async function fetchGateway() {
  try {
    const r = await fetch(GATEWAY_MODELS_URL, { signal: AbortSignal.timeout(15_000) });
    return r.ok ? (await r.json()).data : null;
  } catch { return null; }
}

function fetchWorkersAi() {
  const res = run(WRANGLER, ['ai', 'models', 'list', '--json'], { allowFail: true });
  try { return res.status === 0 ? jsonFrom(res.stdout) : null; } catch { return null; }
}

function readUsage() {
  if (!existsSync(P.usage)) return [];
  return readFileSync(P.usage, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

async function cmdBrief() {
  const now = new Date();
  const inventory = readJson(P.inventory, []);
  const [gateway, workersAi] = [await fetchGateway(), fetchWorkersAi()];
  const md = briefMarkdown({
    now, workersAi, gateway, inventory, due: dueDomains(inventory, domains, now.getTime()), usage: usageToday(readUsage(), now),
  });
  writeAtomic(BRIEF_PATH, md);
  // The full catalog also goes into the corpus, so cloud agents searching it know the newest models too.
  if (workersAi || gateway) writeAtomic(path.join(P.corpus, '_platform', 'latest-models.md'), catalogMarkdown({ now, workersAi, gateway }));
  writeAtomic(path.join(path.dirname(BRIEF_PATH), 'heartbeat.json'), JSON.stringify({
    ts: now.toISOString(), source: 'research-corpus brief', status: workersAi && gateway ? 'ok' : 'degraded',
    workersAi: workersAi?.length ?? 0, gateway: gateway?.length ?? 0, reports: inventory.filter((e) => e.include).length,
  }, null, 2));
  console.log(md);
}

function cmdQueue() {
  const inventory = readJson(P.inventory, []);
  for (const d of dueDomains(inventory, domains)) {
    const age = d.ageDays === null ? 'never' : `${d.ageDays}d`;
    console.log(`${d.due ? 'DUE ' : 'ok  '} ${d.id.padEnd(24)} reports=${String(d.reports).padStart(2)} newest=${age.padStart(6)} window=${d.staleDays}d`);
  }
  console.log(`\nPrompts: ${path.join(HERE, 'deep-research-prompts.md')}`);
}

function cmdUsage() {
  const sub = process.argv[3];
  const ts = new Date().toISOString();
  mkdirSync(HOME, { recursive: true });
  if (sub === 'snapshot') {
    const remaining = flag('remaining');
    if (remaining === undefined) die('usage: usage snapshot --remaining <N> [--note "..."]');
    appendFileSync(P.usage, JSON.stringify({ ts, type: 'snapshot', remaining: Number(remaining), note: flag('note') ?? null }) + '\n');
  } else if (sub === 'run') {
    const domain = flag('domain');
    if (!domains.some((d) => d.id === domain)) die(`--domain must be one of: ${domains.map((d) => d.id).join(', ')}`);
    appendFileSync(P.usage, JSON.stringify({ ts, type: 'run', domain, title: flag('title') ?? null }) + '\n');
  } else if (sub === 'reading') {
    const [s, w] = [flag('session'), flag('weekly')];
    if (s === undefined || w === undefined) die('usage: usage reading --session <pct> --weekly <pct> [--session-resets "19:18"] [--weekly-resets "10 Nov 15:18"] [--shot <file>]');
    appendFileSync(P.usage, JSON.stringify({
      ts, type: 'reading', sessionPct: Number(s), weeklyPct: Number(w),
      sessionResets: flag('session-resets') ?? null, weeklyResets: flag('weekly-resets') ?? null, shot: flag('shot') ?? null,
    }) + '\n');
  } else if (sub === 'done') {
    appendFileSync(P.usage, JSON.stringify({ ts, type: 'done', title: flag('title') ?? null }) + '\n');
  } else if (sub === 'plan') {
    console.log(JSON.stringify(usagePlan(readUsage()), null, 2));
    return;
  } else if (sub !== 'show') die('usage: usage snapshot|run|reading|done|plan|show');
  console.log(JSON.stringify(usageToday(readUsage()), null, 2));
}

const commands = {
  list: cmdList, classify: cmdClassify, export: cmdExport, import: cmdImport, push: cmdPush, sync: cmdSync, status: cmdStatus,
  search: cmdSearch, triage: cmdTriage, eval: cmdEval, audit: cmdAudit, prune: cmdPrune, ask: cmdAsk, brief: cmdBrief, queue: cmdQueue, usage: cmdUsage,
};
const cmd = commands[process.argv[2]];
if (!cmd) die(`commands: ${Object.keys(commands).join(', ')}`, 2);
await cmd();
