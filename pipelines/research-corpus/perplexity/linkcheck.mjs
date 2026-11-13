// Checks that every cited URL in full reports resolves. Writes verticals/LINKCHECK.json.
// usage: node linkcheck.mjs [reportId...]
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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

// Cited URLs come from AI-written reports, so they are untrusted input. Only public hosts are
// fetched, and redirects are followed by hand so every hop is checked; otherwise a report could
// point this script at loopback services (the local tool plane) or cloud metadata endpoints.
const MAX_REDIRECTS = 5;
const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
];
const v4ToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const isPublicIp = (ip) => {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIp(mapped[1]);
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return !PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  const v6 = ip.toLowerCase();
  return !(v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6));
};
const isPublicUrl = async (raw) => {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
  if (isIP(host)) return isPublicIp(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => isPublicIp(a.address));
  } catch { return false; }
};

const fetchChecked = async (url, method, signal) => {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isPublicUrl(current))) return { status: 'not-public' };
    const r = await fetch(current, { method, redirect: 'manual', signal, headers: { 'user-agent': 'Mozilla/5.0 linkcheck' } });
    const next = r.headers.get('location');
    if (r.status < 300 || r.status >= 400 || !next) return { status: r.status };
    current = new URL(next, current).href;
  }
  return { status: 'too-many-redirects' };
};

const check = async (url) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let r = await fetchChecked(url, 'HEAD', ctl.signal);
    if ([400, 403, 405].includes(r.status)) r = await fetchChecked(url, 'GET', ctl.signal);
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
  const unknown = urls.filter((u, k) => ['timeout', 'not-public', 'too-many-redirects'].includes(statuses[k]) || [401, 403, 429].includes(statuses[k]) || statuses[k] >= 500);
  prior[f.replace(/\.md$/, '')] = { checked: new Date().toISOString(), urls: urls.length, dead: dead.length, unknown: unknown.length, deadUrls: dead };
  console.log(`${f}: ${urls.length} urls, ${dead.length} dead, ${unknown.length} blocked/unknown`);
}
writeFileSync(outFile, JSON.stringify(prior, null, 2));
