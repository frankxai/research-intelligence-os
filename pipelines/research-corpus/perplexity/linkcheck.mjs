// Checks that every cited URL in full reports resolves. Writes verticals/LINKCHECK.json.
// usage: node linkcheck.mjs [reportId...]
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Private data lives outside the repo; this public code only reads and writes there.
const here = process.env.PERPLEXITY_HOME || join(homedir(), '.starlight', 'research', 'perplexity');
const reportsDir = join(here, 'reports');
const outFile = join(here, 'verticals', 'LINKCHECK.json');
const CONCURRENCY = 8;
const TIMEOUT_MS = 12000;

const only = process.argv.slice(2);
const files = readdirSync(reportsDir).filter((f) => f.startsWith('kb-') && f.endsWith('.md') && !f.includes('.chat.'))
  .filter((f) => !only.length || only.some((id) => f.startsWith(id)));
const prior = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : {};

const check = async (url) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 linkcheck' } });
    if (r.status === 405 || r.status === 403 || r.status === 400) {
      r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 linkcheck' } });
    }
    return r.status;
  } catch (e) {
    return e.name === 'AbortError' ? 'timeout' : 'error';
  } finally { clearTimeout(t); }
};

const pool = async (items, fn) => {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
};

for (const f of files) {
  const text = readFileSync(join(reportsDir, f), 'utf8');
  const urls = [...new Set([...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]))];
  const statuses = await pool(urls, check);
  // 401/403/429 mean the page exists but blocks bots; only 404/410 and unreachable hosts count as dead.
  const dead = urls.filter((u, k) => [404, 410].includes(statuses[k]) || statuses[k] === 'error');
  const unknown = urls.filter((u, k) => statuses[k] === 'timeout' || [401, 403, 429].includes(statuses[k]) || statuses[k] >= 500);
  prior[f.replace(/\.md$/, '')] = { checked: new Date().toISOString(), urls: urls.length, dead: dead.length, unknown: unknown.length, deadUrls: dead };
  console.log(`${f}: ${urls.length} urls, ${dead.length} dead, ${unknown.length} blocked/unknown`);
}
writeFileSync(outFile, JSON.stringify(prior, null, 2));
