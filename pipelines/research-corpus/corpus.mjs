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
//   node corpus.mjs usage show
//
// All private state lives in RESEARCH_HOME (default ~/.starlight/research), never in this repo.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PERSONAL_PATTERNS, briefMarkdown, catalogMarkdown, classify, corpusKey, dueDomains, frontMatter,
  localFrontMatter, slugify, staleDriveKeys, usageToday,
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

const domains = JSON.parse(readFileSync(path.join(HERE, 'domains.json'), 'utf8')).domains;

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
  const res = run('rclone', ['lsjson', RCLONE_REMOTE, '--files-only', '--max-depth', '1', '-M', '--drive-export-formats', 'md']);
  const files = JSON.parse(res.stdout).map((f) => ({
    id: f.ID,
    title: f.Name.replace(/\.md$/, ''),
    mimeType: f.MimeType === 'text/markdown' ? 'application/vnd.google-apps.document' : f.MimeType,
    createdTime: f.Metadata?.btime || f.ModTime,
    modifiedTime: f.ModTime,
    fileSize: f.Size,
  }));
  writeAtomic(P.listing, JSON.stringify(files, null, 2));
  console.log(`listed ${files.length} files -> ${P.listing}`);
}

function cmdClassify() {
  const source = process.argv[3] || P.listing;
  const raw = readJson(source, null);
  if (!raw) die(`no listing at ${source}; run "list" first or pass a JSON file`);
  const files = Array.isArray(raw) ? raw : raw.files;
  const inventory = classify(files, { domains, personalPatterns: personalPatterns() });
  writeAtomic(P.inventory, JSON.stringify(inventory, null, 2));
  const count = (pred) => inventory.filter(pred).length;
  console.log(JSON.stringify({
    inventory: P.inventory,
    total: inventory.length,
    deepResearch: count((e) => e.kind === 'deep-research' && e.include),
    geminiCanvas: count((e) => e.kind === 'gemini-canvas' && e.include),
    personalExcluded: count((e) => e.kind === 'personal'),
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
    writeAtomic(target, frontMatter(entry, exportedAt) + readFileSync(tmp, 'utf8'));
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

// Dry run by default. --apply deletes the R2 objects and moves the local copies to pruned/,
// so a wrong prune is undone by moving the files back and running push.
async function cmdPrune() {
  const inventory = readJson(P.inventory, null) || die('no inventory; run "classify" first');
  if (!inventory.some((e) => e.include)) die('refusing to prune: the inventory includes no documents, which would empty the corpus');
  const driveKeys = walk(P.corpus)
    .filter((f) => /^source: google-drive$/m.test(readFileSync(f, 'utf8').slice(0, 600)))
    .map((f) => path.relative(P.corpus, f).split(path.sep).join('/'));
  const stale = staleDriveKeys({ driveKeys, inventory });
  for (const key of stale) console.log(`stale  ${key}`);
  if (!process.argv.includes('--apply')) {
    console.log(`${stale.length} of ${driveKeys.length} Drive export(s) stale. Dry run; add --apply to remove them from r2://${BUCKET}.`);
    return;
  }
  const manifest = readJson(P.manifest, {});
  for (const key of stale) {
    run(WRANGLER, ['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote']);
    const target = path.join(HOME, 'pruned', key);
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(path.join(P.corpus, key), target);
    delete manifest[key];
    writeAtomic(P.manifest, JSON.stringify(manifest, null, 2));
  }
  console.log(`pruned ${stale.length} document(s); local copies in ${path.join(HOME, 'pruned')}`);
  if (stale.length && workerToken()) console.log(JSON.stringify(await worker('/sync'), null, 2));
}

function positional() {
  return process.argv.slice(3).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--')).join(' ');
}

async function cmdSearch() {
  const query = positional();
  if (!query) die('usage: corpus.mjs search "<question>" [--domain <id>] [--limit N]');
  const out = await worker('/search', { query, domain: flag('domain'), limit: Number(flag('limit') || 8) });
  for (const p of out.passages) console.log(`\n[${p.score}] ${p.key}\n${p.text.trim().slice(0, 600)}`);
  if (!out.passages.length) console.log('no passages (is the corpus indexed? run: corpus.mjs status)');
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
  } else if (sub !== 'show') die('usage: usage snapshot|run|show');
  console.log(JSON.stringify(usageToday(readUsage()), null, 2));
}

const commands = {
  list: cmdList, classify: cmdClassify, export: cmdExport, import: cmdImport, push: cmdPush, prune: cmdPrune, sync: cmdSync, status: cmdStatus,
  search: cmdSearch, ask: cmdAsk, brief: cmdBrief, queue: cmdQueue, usage: cmdUsage,
};
const cmd = commands[process.argv[2]];
if (!cmd) die(`commands: ${Object.keys(commands).join(', ')}`, 2);
await cmd();
