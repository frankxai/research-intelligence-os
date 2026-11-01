#!/usr/bin/env node
// Research corpus CLI: Google Drive research -> private corpus -> R2 -> Cloudflare AI Search,
// plus a session brief and a Gemini Deep Research usage ledger.
//
//   node corpus.mjs list                 rclone lists Drive root Docs -> drive-listing.json
//   node corpus.mjs classify [listing]   listing -> inventory.json (kind, domain, include)
//   node corpus.mjs export               rclone exports included Docs as markdown + front matter
//   node corpus.mjs push                 uploads corpus/*.md to the R2 bucket AI Search indexes
//   node corpus.mjs search "<question>"  queries the AI Search instance (prints JSON)
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
  DEFAULT_PERSONAL_PATTERNS, briefMarkdown, classify, corpusKey, dueDomains, frontMatter, usageToday,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.RESEARCH_HOME || path.join(homedir(), '.starlight', 'research');
const BRIEF_PATH = process.env.STARLIGHT_BRIEF || path.join(homedir(), '.starlight', 'brief', 'session-brief.md');
const RCLONE_REMOTE = process.env.RESEARCH_DRIVE_REMOTE || 'gdrive:';
const BUCKET = process.env.RESEARCH_BUCKET || 'starlight-research-corpus';
const INSTANCE = process.env.RESEARCH_AI_SEARCH || 'starlight-research';
const GATEWAY_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';

const P = {
  listing: path.join(HOME, 'drive-listing.json'),
  inventory: path.join(HOME, 'inventory.json'),
  exclude: path.join(HOME, 'exclude.txt'),
  corpus: path.join(HOME, 'corpus'),
  usage: path.join(HOME, 'gemini-usage.jsonl'),
  manifest: path.join(HOME, 'push-manifest.json'),
};

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

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.md') ? [path.join(dir, d.name)] : []);
}

function cmdPush() {
  const manifest = readJson(P.manifest, {});
  let pushed = 0;
  for (const file of walk(P.corpus)) {
    const key = path.relative(P.corpus, file).split(path.sep).join('/');
    const mtime = statSync(file).mtimeMs;
    if (manifest[key] === mtime) continue;
    run('npx', ['--no-install', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file,
      '--content-type', 'text/markdown; charset=utf-8', '--remote']);
    manifest[key] = mtime;
    pushed += 1;
  }
  writeAtomic(P.manifest, JSON.stringify(manifest, null, 2));
  console.log(`pushed ${pushed} file(s) to r2://${BUCKET}; AI Search instance "${INSTANCE}" re-indexes on its sync`);
}

function cmdSearch() {
  const query = process.argv.slice(3).filter((a) => !a.startsWith('--')).join(' ');
  if (!query) die('usage: corpus.mjs search "<question>"');
  const res = run('npx', ['--no-install', 'wrangler', 'ai-search', 'search', INSTANCE, '--query', query, '--json']);
  process.stdout.write(res.stdout);
}

async function fetchGateway() {
  try {
    const r = await fetch(GATEWAY_MODELS_URL, { signal: AbortSignal.timeout(15_000) });
    return r.ok ? (await r.json()).data : null;
  } catch { return null; }
}

function fetchWorkersAi() {
  const res = run('npx', ['--no-install', 'wrangler', 'ai', 'models', 'list', '--json'], { allowFail: true });
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

const commands = { list: cmdList, classify: cmdClassify, export: cmdExport, push: cmdPush, search: cmdSearch, brief: cmdBrief, queue: cmdQueue, usage: cmdUsage };
const cmd = commands[process.argv[2]];
if (!cmd) die(`commands: ${Object.keys(commands).join(', ')}`, 2);
await cmd();
