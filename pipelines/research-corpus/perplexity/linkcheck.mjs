// Checks that every cited URL in full reports resolves. Writes verticals/LINKCHECK.json.
// usage: node linkcheck.mjs [reportId...]
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { lookup as dnsLookup } from 'node:dns';
import { isIP, BlockList } from 'node:net';
import http from 'node:http';
import https from 'node:https';

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
const DENY = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) DENY.addSubnet(net, bits, 'ipv4');
// IPv4-embedding prefixes (::/96 compat, 64:ff9b NAT64, 2002 6to4, 2001::/32 Teredo) are refused outright:
// a cited source has no reason to use them and each can smuggle a private IPv4 target.
for (const [net, bits] of [['::', 96], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) DENY.addSubnet(net, bits, 'ipv6');
// BlockList.check on an ipv6 address also matches IPv4-mapped (::ffff:a.b.c.d) forms against the ipv4 rules.
const isPublicIp = (ip) => !DENY.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');

// Resolution happens inside the socket connect, and only a validated address is handed back,
// so the request goes to exactly the address that was checked (no DNS-rebinding window).
const safeLookup = (host, opts, cb) => {
  dnsLookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => isPublicIp(a.address));
    if (!ok.length || ok.length !== addrs.length) return cb(Object.assign(new Error('not-public'), { code: 'ENOTPUBLIC' }));
    return opts.all ? cb(null, ok) : cb(null, ok[0].address, ok[0].family);
  });
};

const request = (url, method, signal) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicIp(host)) return reject(Object.assign(new Error('not-public'), { code: 'ENOTPUBLIC' }));
  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.request(u, { method, lookup: safeLookup, signal, headers: { 'user-agent': 'Mozilla/5.0 linkcheck' } }, (res) => {
    res.resume();
    resolve({ status: res.statusCode, location: res.headers.location });
  });
  req.on('error', reject);
  req.end();
});

const fetchChecked = async (url, method, signal) => {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (!['http:', 'https:'].includes(u.protocol) || u.hostname === 'localhost' || /\.(localhost|internal)$/.test(u.hostname)) {
      return { status: 'not-public' };
    }
    let r;
    try { r = await request(current, method, signal); } catch (e) {
      if (e.code === 'ENOTPUBLIC') return { status: 'not-public' };
      throw e;
    }
    if (r.status < 300 || r.status >= 400 || !r.location) return { status: r.status };
    current = new URL(r.location, current).href;
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
