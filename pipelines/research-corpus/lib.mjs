// Pure functions for the research corpus pipeline. No I/O here, so every rule is testable.
import { createHash } from 'node:crypto';

const DAY_MS = 86_400_000;
const DOC_MIME = 'application/vnd.google-apps.document';

// A Gemini Deep Research export is a long Doc. Shorter titled "Codex", "Blueprint" or "vN.N"
// Docs are Gemini chat/canvas write-ups: useful, but they mix plans with invented run logs,
// so they are indexed under a separate kind and never treated as research evidence.
const DEEP_RESEARCH_MIN_BYTES = 20_000;
const CANVAS_MARKERS = /\b(codex|blueprint|masterplan|charter|spec|playbook|brief|register|index|dossier|decision|proposals|v\d+\.\d+)\b/i;

// Generic personal markers. Owners add their own patterns in the private exclude file, which
// never enters this public repository.
export const DEFAULT_PERSONAL_PATTERNS = [
  'self-analysis', 'self_analysis', 'journal', 'workbook', 'diary', 'private', 'personal',
  'untitled document', 'template',
];

// Business, financing, legal and meeting records are private operating material, not research.
// They are excluded by default so they never reach an index that agents query or a person shares.
export const SENSITIVE_RE = /\b(financing|ondernemingsplan|business plan|qredits|term sheet|invoice|contracting|algemene voorwaarden|notes by gemini|meeting started|draft for|not sent|kvk|tax return|payslip|salary|passport|iban|nda|cap table|data room|legal pack|transcription|transcript|bewerbung|fitness|strategic briefing)\b/i;
// An old revision or a copy the owner already marked as replaced must not outrank its successor.
export const SUPERSEDED_RE = /superseded|\bduplicate\b|obsolete|deprecated|label_historical|^archive\b/i;

export function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

export function routeDomain(title, domains) {
  const lower = title.toLowerCase();
  const hit = domains.find((d) => d.keywords.some((k) => lower.includes(k)));
  return hit ? hit.id : 'unrouted';
}

export function classifyKind(file, personalPatterns) {
  const lower = file.title.toLowerCase();
  if (personalPatterns.some((p) => p && lower.includes(p.toLowerCase()))) return 'personal';
  if (SENSITIVE_RE.test(file.title)) return 'sensitive';
  if (SUPERSEDED_RE.test(file.title.trim())) return 'superseded';
  // With --drive-export-formats md, rclone lists a native Google Doc as text/markdown with size -1;
  // an uploaded .md file has a real size, so the pair identifies native Docs.
  const mime = String(file.mimeType ?? '');
  const nativeDocExport = mime.startsWith('text/markdown') && Number(file.fileSize ?? 0) < 0;
  if (mime !== DOC_MIME && !nativeDocExport) return 'other';
  // rclone reports native Docs as size -1; then the title is the only signal.
  const bytes = Number(file.fileSize ?? -1);
  const longEnough = bytes <= 0 || bytes >= DEEP_RESEARCH_MIN_BYTES;
  if (longEnough && !CANVAS_MARKERS.test(file.title)) return 'deep-research';
  return 'gemini-canvas';
}

// Gemini re-exports a report under the same title, either identically or as a re-run.
// The newest copy is kept; older copies point at it.
function titleKey(file) {
  return file.title.trim().toLowerCase();
}

export function classify(files, { domains, personalPatterns = DEFAULT_PERSONAL_PATTERNS }) {
  const seen = new Map();
  const ordered = [...files].sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));
  return ordered.map((file) => {
    const kind = classifyKind(file, personalPatterns);
    const key = titleKey(file);
    const duplicateOf = seen.get(key) ?? null;
    if (!duplicateOf) seen.set(key, file.id);
    const include = (kind === 'deep-research' || kind === 'gemini-canvas') && !duplicateOf;
    return {
      id: file.id,
      title: file.title,
      kind,
      domain: ['personal', 'sensitive', 'superseded'].includes(kind) ? null : routeDomain(file.title, domains),
      createdTime: file.createdTime,
      modifiedTime: file.modifiedTime,
      bytes: Number(file.fileSize || 0),
      duplicateOf,
      include,
    };
  });
}

// Every corpus file states what it is. "unverified" is deliberate: a Deep Research report is a
// model's synthesis of web sources, so agents must cite it as a claim, never as measured fact.
export function frontMatter(entry, exportedAt, evidence = null) {
  const lines = [
    '---',
    `title: ${JSON.stringify(entry.title)}`,
    `source: google-drive`,
    `source_id: ${entry.id}`,
    `kind: ${entry.kind}`,
    `domain: ${entry.domain}`,
    `created: ${entry.createdTime}`,
    `modified: ${entry.modifiedTime}`,
    `exported: ${exportedAt}`,
    `producer: ${entry.kind === 'deep-research' ? 'gemini-deep-research' : 'gemini-chat'}`,
    `verification: unverified-ai-synthesis`,
    ...(evidence ? [`evidence: ${evidence.cited ? 'cited' : 'uncited'}`, `source_urls: ${evidence.urls}`, `source_hosts: ${evidence.hosts}`] : []),
    '---',
    '',
  ];
  return lines.join('\n');
}

// Local files (estate truth, repo docs, intel briefs) enter the corpus with the path and commit
// they were read from, so an agent can tell a reviewed file from a working-tree draft.
export function localFrontMatter({ title, sourcePath, commit, domain, kind, modified }, importedAt) {
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    'source: local-file',
    `source_path: ${JSON.stringify(sourcePath)}`,
    `source_commit: ${commit || 'untracked-or-uncommitted'}`,
    `kind: ${kind}`,
    `domain: ${domain}`,
    `modified: ${modified}`,
    `imported: ${importedAt}`,
    `verification: ${commit ? 'committed-estate-document' : 'working-tree-draft'}`,
    '---',
    '',
  ].join('\n');
}

export function corpusKey(entry) {
  return `${entry.domain}/${entry.createdTime.slice(0, 10)}-${slugify(entry.title)}.md`;
}

export function dueDomains(inventory, domains, now = Date.now()) {
  return domains
    .map((d) => {
      const reports = inventory.filter((e) => e.include && e.kind === 'deep-research' && e.domain === d.id);
      const newest = reports.map((e) => Date.parse(e.createdTime)).sort((a, b) => b - a)[0];
      const ageDays = newest ? Math.floor((now - newest) / DAY_MS) : null;
      const due = ageDays === null || ageDays >= d.staleDays;
      return { id: d.id, name: d.name, staleDays: d.staleDays, reports: reports.length, ageDays, due };
    })
    .sort((a, b) => Number(b.due) - Number(a.due) || (b.ageDays ?? 1e9) - (a.ageDays ?? 1e9));
}

export function usageToday(ledger, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const today = ledger.filter((r) => String(r.ts).startsWith(day));
  const runs = today.filter((r) => r.type === 'run').length;
  const snapshots = ledger.filter((r) => r.type === 'snapshot');
  const readings = ledger.filter((r) => r.type === 'reading');
  return { day, runs, lastSnapshot: snapshots.at(-1) ?? null, lastReading: readings.at(-1) ?? null };
}

// Gemini Ultra meters usage in percent: a rolling window and a weekly limit, not a run count.
// A run's cost is the rise in each percentage between the last reading before it started
// and the first reading after it finished (a 'done' record). A run that shares that interval with
// another run is skipped because the costs cannot be separated, and so is a run across a meter reset,
// whose difference is not a cost. A run that never finished is closed with an
// 'abandoned' record whose `at` says when it stopped; it is never measured, and it stops
// counting as an overlap after `at`.
// An end record belongs to the run with its title that was active at the end's effective time
// (`at` for an abandon), so a retry under the same title is not paired with the first run's end.
function runEnd(rows, run) {
  const next = rows.find((r) => r.type === 'run' && r.title === run.title && r.ts > run.ts);
  const ends = rows
    .filter((r) => (r.type === 'done' || r.type === 'abandoned') && r.title === run.title)
    .map((r) => ({ type: r.type, ts: r.at ?? r.ts }))
    .filter((e) => e.ts >= run.ts && (!next || e.ts <= next.ts))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  return ends[0] ?? null;
}

// The run a 'done' or 'abandoned' record at `at` would close: same title, started by `at`, not yet
// ended, and not followed by a retry under that title before `at` (the same window runEnd uses).
// null means the closure would match nothing and leave the intended run open.
export function openRunFor(ledger, title, at) {
  const rows = [...ledger].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const same = rows.filter((r) => r.type === 'run' && r.title === title);
  return same.filter((r, i) => r.ts <= at && (!same[i + 1] || at <= same[i + 1].ts) && !runEnd(rows, r)).at(-1) ?? null;
}

export function usagePlan(ledger) {
  const rows = [...ledger].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const readings = rows.filter((r) => r.type === 'reading');
  const costs = [];
  for (const run of rows.filter((r) => r.type === 'run')) {
    const done = runEnd(rows, run);
    if (done?.type !== 'done') continue;
    const before = readings.filter((r) => r.ts <= run.ts).at(-1);
    const after = readings.find((r) => r.ts >= done.ts);
    if (!before || !after) continue;
    // Any other run active between the two readings shares the rise, so no single cost can be read
    // from it: this covers runs that overlap this one and runs before or after it in the same interval.
    const shared = rows.some((r) => {
      if (r.type !== 'run' || r === run) return false;
      const rEnd = runEnd(rows, r);
      return r.ts < after.ts && (!rEnd || rEnd.ts > before.ts);
    });
    // Every reading from `before` to `after`: a meter that fell between any two of them, or a session
    // or weekly reset that one of them announced for a time before `after`, means a reset mid-interval,
    // and then the difference is not a cost.
    const span = readings.filter((r) => r.ts >= before.ts && r.ts <= after.ts);
    const fell = span.some((r, i) => i > 0 && (r.weeklyPct < span[i - 1].weeklyPct || r.sessionPct < span[i - 1].sessionPct));
    const end = Date.parse(after.ts);
    const announced = span.slice(0, -1).some((r) =>
      [windowResetAfter(r.ts, r.sessionResets), weeklyResetAfter(r.ts, r.weeklyResets)].some((t) => t !== null && t <= end));
    if (shared || fell || announced) continue;
    costs.push({
      title: run.title, domain: run.domain,
      weekly: after.weeklyPct - before.weeklyPct, session: after.sessionPct - before.sessionPct,
    });
  }
  const mean = (key) => (costs.length ? costs.reduce((s, c) => s + c[key], 0) / costs.length : null);
  const weeklyPerRun = mean('weekly');
  const sessionPerRun = mean('session');
  const latest = readings.at(-1) ?? null;
  const left = (pct, per) => (latest && per > 0 ? Math.floor((100 - pct) / per) : null);
  return {
    measuredRuns: costs.length, costs, weeklyPerRun, sessionPerRun, latest,
    runsLeftThisWeek: left(latest?.weeklyPct, weeklyPerRun),
    runsLeftThisWindow: left(latest?.sessionPct, sessionPerRun),
    runsPerWeek: weeklyPerRun > 0 ? Math.floor(100 / weeklyPerRun) : null,
    runsPerWindow: sessionPerRun > 0 ? Math.floor(100 / sessionPerRun) : null,
  };
}

function perMillion(perToken) {
  const n = Number(perToken);
  return Number.isFinite(n) && n > 0 ? `$${+(n * 1e6).toFixed(2)}` : '?';
}

export function gatewayFacts(m) {
  const released = m.released ? new Date(m.released * 1000).toISOString().slice(0, 10) : 'unknown date';
  const ctx = m.context_window ? `${Math.round(m.context_window / 1000)}k ctx` : 'ctx ?';
  const price = m.pricing ? `${perMillion(m.pricing.input)}/${perMillion(m.pricing.output)} per M in/out` : 'price ?';
  return `(${released}, ${ctx}, ${price})`;
}

function newest(list, dateOf, n) {
  return [...list].sort((a, b) => dateOf(b) - dateOf(a)).slice(0, n);
}

// The searchable catalog: every Workers AI text model and the 40 newest gateway language models.
export function catalogMarkdown({ now, workersAi, gateway }) {
  const day = now.toISOString().slice(0, 10);
  const out = [
    '---', 'title: "Latest AI models on Cloudflare Workers AI and Vercel AI Gateway"', 'source: live-catalogs',
    'kind: platform-catalog', 'domain: ai-models-platforms', `generated: ${now.toISOString()}`,
    'verification: measured-from-provider-api', '---', '',
    `# Latest AI models (catalog snapshot ${day})`, '',
    'Generated from the providers\' own model APIs, not from memory. Use these exact model IDs.', '',
  ];
  if (workersAi?.length) {
    out.push('## Cloudflare Workers AI text generation models (newest first)', '');
    const text = workersAi.filter((m) => m.task?.name === 'Text Generation');
    for (const m of newest(text, (x) => Date.parse(x.created_at), text.length)) {
      out.push(`- \`${m.name}\` added ${m.created_at.slice(0, 10)}: ${(m.description || '').replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    out.push('');
  }
  if (gateway?.length) {
    out.push('## Vercel AI Gateway language models (40 newest by release date)', '');
    const language = gateway.filter((m) => m.type === 'language' && !m.id.endsWith('-batch'));
    for (const m of newest(language, (x) => Number(x.released || 0), 40)) out.push(`- \`${m.id}\` ${gatewayFacts(m)}`);
    out.push('');
  }
  return out.join('\n');
}

export function briefMarkdown({ now, workersAi, gateway, inventory, due, usage }) {
  const out = [`# Starlight session brief: ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`, ''];

  out.push('## Newest models (live catalogs, not memory)');
  if (workersAi?.length) {
    const textGen = workersAi.filter((m) => m.task?.name === 'Text Generation');
    const picks = newest(textGen, (m) => Date.parse(m.created_at), 8);
    out.push(`Workers AI (${workersAi.length} models): ${picks.map((m) => `\`${m.name}\` (${m.created_at.slice(0, 10)})`).join(', ')}`);
  } else out.push('Workers AI: catalog unavailable this run.');
  if (gateway?.length) {
    // `created` is the gateway's own import time and identical for every row; `released` is the model's date.
    const language = gateway.filter((m) => m.type === 'language' && !m.id.endsWith('-batch'));
    const picks = newest(language, (m) => Number(m.released || 0), 12);
    out.push(`Vercel AI Gateway (${gateway.length} models), newest language models:`);
    for (const m of picks) out.push(`- \`${m.id}\` ${gatewayFacts(m)}`);
  } else out.push('Vercel AI Gateway: catalog unavailable this run.');
  out.push('');

  const reports = inventory.filter((e) => e.include && e.kind === 'deep-research');
  out.push(`## Research corpus (${reports.length} Deep Research reports, ${inventory.filter((e) => e.include && e.kind === 'gemini-canvas').length} Gemini write-ups)`);
  for (const e of newest(reports, (r) => Date.parse(r.createdTime), 6)) {
    out.push(`- ${e.createdTime.slice(0, 10)} [${e.domain}] ${e.title}`);
  }
  out.push('Search it with the `starlight-research` MCP tools (research_search, research_ask), or `node pipelines/research-corpus/corpus.mjs search "<question>"`. Reports are unverified AI synthesis: cite as claims.');
  out.push('');

  const dueList = due.filter((d) => d.due).slice(0, 6);
  out.push('## Research due');
  out.push(dueList.length
    ? dueList.map((d) => `${d.id} (${d.ageDays === null ? 'never researched' : `${d.ageDays}d old, window ${d.staleDays}d`})`).join(' · ')
    : 'Every domain is inside its freshness window.');
  out.push('');

  out.push('## Gemini Deep Research usage');
  const snap = usage.lastSnapshot;
  const rd = usage.lastReading;
  if (rd) out.push(`Meter ${rd.ts.slice(0, 16)}: window ${rd.sessionPct}% used (resets ${rd.sessionResets}), week ${rd.weeklyPct}% used (resets ${rd.weeklyResets}).`);
  out.push(`Today: ${usage.runs} run(s) logged.` + (snap
    ? ` Last app reading ${snap.ts.slice(0, 16)}: ${snap.remaining ?? '?'} Deep Research left${snap.note ? ` (${snap.note})` : ''}.`
    : ' No app reading recorded yet; Google no longer publishes a fixed Ultra quota, so read it from the app.'));
  return out.join('\n') + '\n';
}

// A report is "cited" when it carries enough distinct links from enough distinct hosts to check.
// This measures presence of sources, not their truth: a cited claim is still unverified.
export function evidenceStats(markdown) {
  const urls = new Set(markdown.match(/https?:\/\/[^\s)\]>"']+/g) ?? []);
  const hosts = new Set([...urls].map((u) => { try { return new URL(u).hostname; } catch { return ''; } }).filter(Boolean));
  const hasSources = /^#{1,4}\s*(works cited|sources|references|bibliography)\b/im.test(markdown);
  const words = markdown.split(/\s+/).filter(Boolean).length;
  return { words, urls: urls.size, hosts: hosts.size, hasSources, cited: urls.size >= 10 && hosts.size >= 5 };
}

// Split a corpus markdown file into passages that keep their nearest heading, so a hit can be
// cited by section. Front matter is parsed into fields and kept out of the passages.
export function chunkMarkdown(text, maxChars = 1200) {
  let body = text;
  const meta = {};
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+): (.*)$/);
      if (m) meta[m[1]] = m[2].replace(/^"|"$/g, '');
    }
  }
  const chunks = [];
  let heading = meta.title ?? '';
  let buf = '';
  const flush = () => { if (buf.trim()) chunks.push({ heading, text: buf.trim() }); buf = ''; };
  for (const para of body.split(/\n{2,}/)) {
    const h = para.match(/^#{1,4}\s+(.*)$/m);
    if (h && para.startsWith('#')) { flush(); heading = h[1].trim(); }
    if (buf.length + para.length > maxChars) flush();
    buf += (buf ? '\n\n' : '') + para;
  }
  flush();
  return { meta, chunks };
}

const STOP = new Set('the a an and or of to in on for with is are was be by as at it this that from not but if than then we you i'.split(' '));
export function tokenize(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
}

// Okapi BM25 over passages. It is the baseline to beat before any vector index is trusted.
export function bm25Rank(passages, query, { k1 = 1.5, b = 0.75, limit = 8 } = {}) {
  const docs = passages.map((p) => tokenize(`${p.heading} ${p.text}`));
  const avg = docs.reduce((s, d) => s + d.length, 0) / (docs.length || 1);
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(tokenize(query))];
  const scored = docs.map((d, i) => {
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - df.get(t) + 0.5) / (df.get(t) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    return { i, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => ({ ...passages[s.i], score: +s.score.toFixed(3) }));
}

// ---------------------------------------------------------------------------------------------
// Claim-level evidence. The unit of trust is one claim and the source it cites, not a document.
// `verify sample` writes pending records; a checker who did not write the report fills in the
// excerpt, the source's own date, the status and any contradictions; `verify score` tallies them.

export const CLAIM_SCHEMA = 'claim-evidence/v1';
// verified: every material fact in the claim appears in the source. partial: some do, none conflict.
// unsupported: source reachable, facts absent. contradicted: source states something different.
// garbled: the claim or its citation is corrupted, so it cannot be checked as written.
// unreachable: the URL failed after one retry (a 404 on a vendor path may mean an invented URL).
export const CLAIM_STATUSES = ['pending', 'verified', 'partial', 'unsupported', 'contradicted', 'garbled', 'unreachable'];
// Hypotheses, not calibrated values: they gate a report's release, never rank it.
const MAX_FAILED_SHARE = 0.2;
const MAX_UNREACHABLE_SHARE = 0.3;

const URL_RE = /https?:\/\/[^\s<>()[\]|,"'`]+/g;

// Google Docs markdown escapes punctuation (https\://, www\., \$, \|); undo it before reading text.
export function unescapeMd(s) {
  return String(s).replace(/\\([\\`*_{}[\]()#+\-.!|:~$<>&])/g, '$1');
}

function cleanMd(s) {
  return unescapeMd(String(s).replace(/\*\*/g, '')).replace(/\s+/g, ' ').trim();
}

function normUrl(u) {
  return String(u).replace(/^https?:\/\/(www\.)?/, '').replace(/[/.]+$/, '').toLowerCase();
}

// The heading must be the whole line, so "## Sources of revenue" is not mistaken for the list.
const WORKS_CITED_RE = /^#{1,4}\s*\**\s*(?:works cited|sources|references|bibliography)\s*\**\s*:?\s*$/im;

// Numbered "Works cited" entries -> Map(n -> { title, url }).
export function parseWorksCited(markdown) {
  const refs = new Map();
  const start = markdown.search(WORKS_CITED_RE);
  if (start < 0) return refs;
  for (const line of markdown.slice(start).split(/\r?\n/)) {
    const m = line.match(/^\s*>?\s*(\d{1,4})\.\s+(.+)$/);
    if (!m) continue;
    const plain = unescapeMd(m[2]);
    const url = m[2].match(/\]\((https?:\/\/[^)\s]+)\)/)?.[1] ?? plain.match(URL_RE)?.[0];
    if (!url) continue;
    refs.set(Number(m[1]), { title: plain.split(/,\s*\[|\[|https?:\/\//)[0].replace(/[,\s]+$/, '').trim(), url });
  }
  return refs;
}

// A Docs export glues superscript citations to the text before them ("tracking6.", "sub)9.",
// "**2026**59", "Dec 2026110;", "user/mo5."). A run counts only at the end of a sentence, clause
// or cell, and only after a closing bracket, a closing bold marker, a percent sign, a word of three
// or more letters ending in lowercase, a unit after a slash, or a 20xx year. So "x402", "v4",
// "GB10", "GPT5.", "SOC2.", "**4 Nov", "$0.10" and "base64 encoding" survive. A miss (a citation
// left in the text) is preferred to a false strip: the raw cell is kept beside the cleaned claim.
const CITE_RE = /(\)|(?<=[\w).%])\*\*|%|[A-Za-z]{2,}[a-z]|(?<=\/)[a-z]{2}|\b20[2-3]\d)(\d{1,3})(?=[.;,:](?:\s|$)|$)/g;
// Names whose version number follows them directly ("React19,", "IPv6.", "Python3.").
const VERSIONED = /^(ipv|react|node|next|nuxt|vue|svelte|angular|python|java|php|perl|ruby|rails|django|postgres|postgresql|mysql|redis|ubuntu|debian|fedora|windows|android|chrome|firefox|safari|llama|qwen|gemma|gemini|claude|grok|kimi|mistral|deepseek|opus|sonnet|haiku|tls|http)$/i;

export function splitCitations(text, maxRef = 999) {
  const refs = [];
  const clean = String(text).replace(CITE_RE, (all, lead, num) => {
    const n = Number(num);
    if (n < 1 || n > maxRef || VERSIONED.test(lead)) return all;
    refs.push(n);
    return lead;
  });
  return { text: clean, refs };
}

// Text between two dollar signs that lost its spaces ("$0.25cache),claude-opus-5-5($4") was read as
// inline math somewhere between the model and the export; its numbers cannot be trusted as written.
const SPACING_LOST_RE = [/\$[^$\s]{16,}\$/, /\$[\d.,]+[a-z]{3,}/i, /[A-Za-z0-9]\(\$/, /\)[,;]?[a-z]{2,}/, /\d%[A-Za-z]{3,}/];

// Deterministic checks run before any model judges a claim.
export function claimSignals(claim, { sourceUrls = [], refs = [], worksCited = new Map() } = {}) {
  const signals = [];
  if (SPACING_LOST_RE.some((re) => re.test(claim))) signals.push('spacing-lost');
  if (!sourceUrls.length && !refs.length) signals.push('no-source');
  if (worksCited.size && sourceUrls.length) {
    const cited = new Set([...worksCited.values()].map((r) => normUrl(r.url)));
    if (!cited.has(normUrl(sourceUrls[0]))) signals.push('url-not-in-works-cited');
    const refUrls = refs.map((n) => worksCited.get(n)?.url).filter(Boolean).map(normUrl);
    const own = new Set(sourceUrls.map(normUrl));
    if (refUrls.length && !refUrls.some((u) => own.has(u))) signals.push('ref-differs-from-source-url');
  }
  return signals;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
}

// Rows of the report's own claims table (the Deep Research prompt asks for one).
function tableClaims(lines, maxRef) {
  const out = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const head = lines[i].trim().startsWith('|') ? splitRow(lines[i]).map((c) => cleanMd(c).toLowerCase()) : null;
    // GFM delimiter row: one or more hyphens per cell, optional colons.
    if (!head || !/^\|\s*:?-+:?\s*\|/.test(lines[i + 1].trim())) continue;
    const col = (re) => head.findIndex((h) => re.test(h));
    const claimCol = col(/claim|finding|metric/);
    const urlCol = head.findIndex((h, k) => k !== claimCol && /url|source/.test(h));
    if (claimCol < 0 || urlCol < 0) continue;
    const dateCol = col(/date|vintage|as of/);
    const catCol = col(/category|topic|area/);
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j += 1) {
      const cells = splitRow(lines[j]);
      const { text, refs } = splitCitations(cells[claimCol] ?? '', maxRef);
      const claim = cleanMd(text);
      if (!claim) continue;
      out.push({
        origin: 'table', category: catCol >= 0 ? cleanMd(cells[catCol] ?? '') : null, claim, claimRaw: cells[claimCol],
        sourceUrls: [...new Set(unescapeMd(cells[urlCol] ?? '').match(URL_RE) ?? [])],
        claimedDate: dateCol >= 0 ? cleanMd(splitCitations(cells[dateCol] ?? '', maxRef).text) : null, refs,
      });
    }
    i = j - 1;
  }
  return out;
}

// Prose sentences that end in a citation number, mapped to their Works cited URL.
function proseClaims(body, worksCited, maxRef) {
  const out = [];
  for (const para of body.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p || /^(#|\||>|\[image)/.test(p)) continue;
    for (const sentence of p.split(/(?<=[.!?])\s+(?=[A-Z*])/)) {
      const { text, refs } = splitCitations(sentence, maxRef);
      if (!refs.length) continue;
      out.push({
        origin: 'prose', category: null, claim: cleanMd(text), claimRaw: sentence,
        sourceUrls: refs.map((n) => worksCited.get(n)?.url).filter(Boolean), claimedDate: null, refs,
      });
    }
  }
  return out;
}

// from: 'auto' (the claims table when the report has one, otherwise cited prose), 'table', 'prose' or 'all'.
export function extractClaims(markdown, { from = 'auto' } = {}) {
  const worksCited = parseWorksCited(markdown);
  const fm = markdown.match(/^---\n[\s\S]*?\n---\n/);
  const body = markdown.slice(fm ? fm[0].length : 0).split(WORKS_CITED_RE)[0];
  // The highest number, not the count: an entry without a URL is skipped but keeps its number.
  const maxRef = worksCited.size ? Math.max(...worksCited.keys()) : 999;
  const table = from === 'prose' ? [] : tableClaims(body.split(/\r?\n/), maxRef);
  const prose = from === 'table' || (from === 'auto' && table.length) ? [] : proseClaims(body, worksCited, maxRef);
  const seen = new Set();
  return [...table, ...prose].filter((c) => !seen.has(c.claim) && seen.add(c.claim)).map((c) => ({
    ...c,
    citedRefs: c.refs.map((n) => ({ n, url: worksCited.get(n)?.url ?? null })),
    signals: claimSignals(c.claim, { sourceUrls: c.sourceUrls, refs: c.refs, worksCited }),
  }));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seeded, so a sample can be reproduced; round-robin over categories, so one topic cannot fill it.
export function sampleClaims(claims, n, seed = 1) {
  const rand = mulberry32(seed);
  const shuffled = claims.map((c) => [rand(), c]).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  const groups = new Map();
  for (const c of shuffled) {
    const k = c.category ?? '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const queues = [...groups.values()];
  const want = Math.min(n, claims.length);
  const out = [];
  while (out.length < want) for (const q of queues) if (q.length && out.length < want) out.push(q.shift());
  return out;
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

// A claim's identity: the full digest of its text and its sources, so two claims cannot share one.
function claimId(reportKey, c) {
  return `${reportKey}#${sha256(JSON.stringify([c.claim, c.sourceUrls]))}`;
}

// Front matter fields the pipeline rewrites on every export or import. Every other field (source_id,
// source_commit, kind, verification, ...) is provenance and is hashed with the body.
const VOLATILE_FRONT_MATTER = /^(exported|imported|generated):/;

// The digest of the report the claims were drawn from: the whole file except the volatile timestamps,
// so a re-export that only rewrites `exported:` keeps it and any other change breaks it.
export function reportDigest(markdown) {
  const text = String(markdown);
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  const stable = fm
    ? `---\n${fm[1].split('\n').filter((l) => !VOLATILE_FRONT_MATTER.test(l)).join('\n')}\n---\n${text.slice(fm[0].length)}`
    : text;
  return sha256(stable);
}

// The sample seed comes from the report digest, so nobody picks it: the same report always yields
// the same sample, and a different seed is a different report.
export function seedFromDigest(digest) {
  return Number.parseInt(String(digest).slice(0, 8), 16);
}

export function claimRecords(claims, { reportKey, sampledAt, seed, from = 'auto', reportSha256 = null }) {
  return claims.map((c) => ({
    schema: CLAIM_SCHEMA, id: claimId(reportKey, c), report_key: reportKey, report_sha256: reportSha256,
    sample_from: from, sampled_at: sampledAt, seed,
    origin: c.origin, category: c.category, claim: c.claim, claim_raw: c.claimRaw,
    sample_size: claims.length,
    source_url: c.sourceUrls[0] ?? null, source_urls: c.sourceUrls, cited_refs: c.citedRefs, claimed_date: c.claimedDate,
    signals: c.signals,
    status: 'pending', excerpt: null, source_date: null, contradictions: [], checked_at: null, checker: null, method: null, notes: null,
  }));
}

// The sampling manifest is written once by `verify sample`, beside the claims file the checker edits,
// and `verify score` takes the sample's parameters and identities from it alone. Its self-hash catches
// an accidental or partial edit; it is not a signature (see README, "Threat model").
export const MANIFEST_SCHEMA = 'claim-sample/v1';
const MANIFEST_FIELDS = ['schema', 'report_key', 'report_sha256', 'seed', 'seed_source', 'mode', 'size', 'claim_ids', 'sampled_at'];

export function manifestHash(manifest) {
  return sha256(JSON.stringify(MANIFEST_FIELDS.map((k) => [k, manifest?.[k] ?? null])));
}

// The sample `verify sample` writes and `verify score` redraws: the same report, size and mode always
// give the same records, because the seed is derived from the report digest.
export function drawSample(markdown, { reportKey, n, from = 'auto', sampledAt = null }) {
  const digest = reportDigest(markdown);
  const seed = seedFromDigest(digest);
  const claims = extractClaims(markdown, { from });
  const records = claimRecords(sampleClaims(claims, n, seed), { reportKey, sampledAt, seed, from, reportSha256: digest });
  const body = {
    schema: MANIFEST_SCHEMA, report_key: reportKey, report_sha256: digest, seed, seed_source: 'report_sha256',
    mode: from, size: records.length, claim_ids: records.map((r) => r.id), sampled_at: sampledAt,
  };
  return { claimsInReport: claims.length, records, manifest: { ...body, manifest_sha256: manifestHash(body) } };
}

// The default --n. A smaller sample passes only when the whole report (every extraction mode) has
// fewer claims than this, so choosing a narrow mode cannot shrink the minimum.
const MIN_RELEASE_SAMPLE = 10;
export function releaseMinimum(markdown) {
  return Math.min(MIN_RELEASE_SAMPLE, extractClaims(markdown, { from: 'all' }).length);
}
// What a checker fills in. Every other field is redrawn from the report and must match it.
const NOT_REDRAWN = new Set(['status', 'excerpt', 'source_date', 'contradictions', 'checked_at', 'checker', 'method', 'notes', 'sampled_at']);
const SUPPORTED_VERDICTS = new Set(['verified', 'partial', 'contradicted']);

// A status is an assertion; the record must carry what backs it. Every checked record names its
// checker and when it was checked; verified, partial and contradicted also quote the source.
// source_date is not required: many sources carry no date, and a required field invites invented ones.
function lacksEvidence(r) {
  if (!CLAIM_STATUSES.includes(r.status) || r.status === 'pending') return false;
  const filled = (v) => typeof v === 'string' && v.trim() !== '';
  if (!filled(r.checker) || Number.isNaN(Date.parse(r.checked_at))) return true;
  return SUPPORTED_VERDICTS.has(r.status) && !filled(r.excerpt);
}

// Every URL the report cites, in the two forms claims take them from: table cells and Works cited.
function citedUrls(markdown) {
  const urls = [...(unescapeMd(markdown).match(URL_RE) ?? []), ...[...parseWorksCited(markdown).values()].map((r) => r.url)];
  return new Set(urls.map(normUrl));
}

// The manifest is checked against itself, the report and the seed derivation before anything in it is
// trusted; then the claims file must hold exactly its claims, once each, changed only in checker fields.
// Seed, size and mode written in the records are informational and must agree with the manifest.
function sampleBlocks(records, reportKey, reportText, manifest) {
  const blocks = [];
  const ids = Array.isArray(manifest.claim_ids) ? manifest.claim_ids : [];
  if (manifest.manifest_sha256 !== manifestHash(manifest)) blocks.push('the sampling manifest was edited after sampling (self-hash mismatch)');
  if (manifest.report_key !== reportKey) blocks.push(`the sampling manifest describes ${manifest.report_key}, not ${reportKey}`);
  if (manifest.report_sha256 !== reportDigest(reportText)) blocks.push('the report changed since the sample was drawn (body or provenance front matter): resample with --force');
  if (manifest.seed !== seedFromDigest(manifest.report_sha256)) blocks.push('the sample seed is not the one derived from the report digest');
  const { records: expected } = drawSample(reportText, { reportKey, n: Number(manifest.size) || 0, from: manifest.mode });
  if (ids.length !== manifest.size || JSON.stringify(expected.map((e) => e.id)) !== JSON.stringify(ids)) {
    blocks.push('the sampling manifest does not match the sample redrawn from the report');
  }
  const floor = releaseMinimum(reportText);
  if (!(manifest.size >= floor)) blocks.push(`a sample of ${manifest.size} is below the release minimum of ${floor} claims for this report: resample with --from all or a larger --n`);
  const present = new Set(records.map((r) => r.id));
  const missing = ids.filter((id) => !present.has(id)).length;
  if (missing) blocks.push(`${missing} sampled record(s) missing from the file`);
  if (records.length !== ids.length) blocks.push(`the file holds ${records.length} record(s); the manifest sampled ${ids.length}`);
  const byId = new Map(expected.map((e) => [e.id, e]));
  const altered = records.filter((r) => {
    const e = ids.includes(r.id) ? byId.get(r.id) : null;
    return !e || Object.keys(e).some((k) => !NOT_REDRAWN.has(k) && JSON.stringify(r[k]) !== JSON.stringify(e[k]));
  }).length;
  if (altered) blocks.push(`${altered} record(s) differ from the manifest's sample (claim, source or sample fields edited, or not in this sample)`);
  return blocks;
}

// reportKey: the report the caller asked about. reportText: that report as it is now, or null when it
// is gone. manifest: the sampling manifest written by `verify sample`, or null when there is none.
export function scoreClaims(records, { reportKey = null, reportText = null, manifest = null } = {}) {
  const byStatus = Object.fromEntries(CLAIM_STATUSES.map((s) => [s, 0]));
  for (const r of records) byStatus[CLAIM_STATUSES.includes(r.status) ? r.status : 'pending'] += 1;
  const checked = records.length - byStatus.pending - byStatus.unreachable;
  const rate = (x) => (checked ? +(x / checked).toFixed(3) : null);
  const failed = byStatus.unsupported + byStatus.contradicted + byStatus.garbled;
  const blocks = [];
  const unique = new Set(records.map((r) => r.id)).size;
  if (!records.length) blocks.push('no claim records');
  else if (reportText === null) blocks.push('the report is missing from the corpus');
  else if (!manifest) blocks.push('no sampling manifest for this report: resample with verify sample --force');
  else blocks.push(...sampleBlocks(records, reportKey, reportText, manifest));
  if (unique < records.length) blocks.push(`${records.length - unique} duplicate record(s): each sampled claim counts once`);
  if (records.some((r) => r.report_key !== reportKey)) blocks.push(`record(s) describe a report other than ${reportKey}`);
  const unbacked = records.filter(lacksEvidence).length;
  if (unbacked) blocks.push(`${unbacked} checked claim(s) lack evidence (checker, checked_at, and an excerpt for verified, partial or contradicted)`);
  // A supported verdict names the source it was checked against, and that source is one the report cites.
  const cited = reportText === null ? new Set() : citedUrls(reportText);
  const unattributed = records.filter((r) => SUPPORTED_VERDICTS.has(r.status) && (typeof r.source_url !== 'string'
    || !r.source_url.trim() || (r.signals ?? []).includes('no-source') || !cited.has(normUrl(r.source_url)))).length;
  if (unattributed) blocks.push(`${unattributed} verified, partial or contradicted claim(s) have no source URL the report cites`);
  if (byStatus.contradicted) blocks.push(`${byStatus.contradicted} claim(s) contradicted by the cited source`);
  if (checked && failed / checked > MAX_FAILED_SHARE) blocks.push(`${failed}/${checked} checked claims unsupported, contradicted or garbled (limit ${MAX_FAILED_SHARE * 100}%)`);
  if (records.length && byStatus.unreachable / records.length > MAX_UNREACHABLE_SHARE) blocks.push('too many unreachable sources to judge the sample');
  if (byStatus.pending) blocks.push(`${byStatus.pending} claim(s) not yet checked`);
  return {
    total: records.length, checked, byStatus,
    verifiedRate: rate(byStatus.verified), supportedRate: rate(byStatus.verified + byStatus.partial),
    release: blocks.length ? 'blocked' : 'pass', blocks,
  };
}

export function claimChecklist(records, { reportKey, claimsInReport }) {
  const out = [
    `# Claim check: ${reportKey}`, '',
    `${records.length} of ${claimsInReport} claims, seed ${records[0]?.seed ?? '?'}, sampled ${records[0]?.sampled_at ?? '?'}.`,
    `Fill the matching record in the .claims.jsonl file (the source of truth). Statuses: ${CLAIM_STATUSES.join(', ')}.`,
    `Edit only ${[...NOT_REDRAWN].filter((f) => f !== 'sampled_at').join(', ')}; any other change blocks release.`, '',
  ];
  records.forEach((r, i) => {
    out.push(`## ${i + 1}. ${r.category ?? r.origin}`, '', `- Claim: ${r.claim}`, `- Report's date: ${r.claimed_date ?? 'n/a'}`,
      `- Source: ${r.source_urls.join(' , ') || 'none'}`);
    if (r.cited_refs.length) out.push(`- Cited refs: ${r.cited_refs.map((c) => `[${c.n}] ${c.url ?? '?'}`).join(' ; ')}`);
    if (r.signals.length) out.push(`- Signals: ${r.signals.join(', ')}`);
    out.push(`- [ ] Status: ${r.status}`, '');
  });
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Pipeline health: the checks that catch silent failures before a scheduled run reports green.
const HOUR_MS = 3_600_000;
const LISTING_STALE_H = 36;
const RUN_STALL_MIN = 90;
const LAST_RUN_STALE_H = 30;
const RUN_MAX_MIN = 75; // matches the Task Scheduler limit in register-daily.ps1
const WINDOW_HOLD_PCT = 90;
const READING_STALE_H = 5;

// The Usage limits page shows the window reset as local "HH:MM"; readings are taken on this machine,
// so the next local occurrence after the reading is when that reading stops describing the window.
export function windowResetAfter(readingTs, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const at = new Date(readingTs);
  const reset = new Date(at);
  reset.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (reset <= at) reset.setDate(reset.getDate() + 1);
  return reset.getTime();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// The weekly reset shows as local "D Mon HH:MM" ("10 Nov 15:18"): the next such time after the reading.
export function weeklyResetAfter(readingTs, text) {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (month < 0) return null;
  const at = new Date(readingTs);
  const reset = new Date(at.getFullYear(), month, Number(m[1]), Number(m[3]), Number(m[4]));
  if (reset <= at) reset.setFullYear(reset.getFullYear() + 1);
  return reset.getTime();
}

function slugOf(key) {
  return key.split('/').pop().replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

export function pipelineHealth({ now = Date.now(), corpus = [], quarantineKeys = [], excludedIds = [], listingMtimeMs = null, ledger = [], lastRun = null }) {
  const findings = [];
  const add = (check, level, detail) => findings.push({ check, level, detail });

  const blocked = new Set(excludedIds);
  const qKeys = new Set(quarantineKeys);
  const leaks = corpus.filter((c) => qKeys.has(c.key) || (c.sourceId && blocked.has(c.sourceId)));
  if (leaks.length) add('quarantine-leak', 'fail', leaks.map((c) => c.key));
  const qSlugs = new Set(quarantineKeys.map(slugOf));
  const twins = corpus.filter((c) => !leaks.includes(c) && qSlugs.has(slugOf(c.key)));
  if (twins.length) add('quarantine-twin', 'warn', `${twins.length} corpus file(s) share a title with a quarantined one (new Drive id or date?): ${twins.map((c) => c.key).join(', ')}`);

  if (listingMtimeMs === null) add('listing-age', 'warn', 'no Drive listing yet');
  else if (now - listingMtimeMs > LISTING_STALE_H * HOUR_MS) add('listing-age', 'warn', `Drive listing is ${Math.round((now - listingMtimeMs) / HOUR_MS)}h old`);

  const rows = [...ledger].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const stalled = rows.filter((r) => r.type === 'run' && now - Date.parse(r.ts) > RUN_STALL_MIN * 60_000 && !runEnd(rows, r));
  if (stalled.length) add('stalled-runs', 'warn', `${stalled.length} Deep Research run(s) logged without "done" after ${RUN_STALL_MIN} min: close each with "usage done" or "usage abandon --at <when it stopped>", or usage plan treats later runs as overlapping and cannot measure them`);

  const reading = rows.filter((r) => r.type === 'reading').at(-1);
  const reset = reading ? windowResetAfter(reading.ts, reading.sessionResets) : null;
  if (!reading) add('usage-reading', 'warn', 'no usage reading; take one before any Deep Research launch');
  else if ((reset !== null && now >= reset) || now - Date.parse(reading.ts) > READING_STALE_H * HOUR_MS) add('usage-reading', 'warn', 'the window has reset or the reading is old; take a new reading before launching');
  else if (reading.sessionPct >= WINDOW_HOLD_PCT) add('usage-window', 'warn', `window at ${reading.sessionPct}%: hold launches until ${reading.sessionResets ?? 'reset'}`);

  // scheduled-run.ps1 writes "running" first, so a run killed by the scheduler cannot leave the
  // previous run's "ok" behind.
  const runAgeMin = lastRun ? (now - Date.parse(lastRun.ts)) / 60_000 : 0;
  if (!lastRun) add('last-run', 'warn', 'no scheduled run recorded yet');
  else if (lastRun.status === 'running' && runAgeMin > RUN_MAX_MIN) add('last-run', 'fail', `scheduled run started ${Math.round(runAgeMin)} min ago and never finished (killed by the scheduler?)`);
  else if (lastRun.status === 'running') add('last-run', 'warn', 'a scheduled run is in progress');
  // Only records written before skips stopped touching last-run.json carry this status.
  else if (lastRun.status === 'skipped-locked') add('last-run', 'warn', 'last scheduled run skipped: another run held the lock');
  else if (lastRun.status !== 'ok') add('last-run', 'fail', `last scheduled run ended "${lastRun.status}"`);
  else if (now - Date.parse(lastRun.ts) > LAST_RUN_STALE_H * HOUR_MS) add('last-run', 'warn', `last scheduled run was ${Math.round((now - Date.parse(lastRun.ts)) / HOUR_MS)}h ago`);

  return { ok: !findings.some((f) => f.level === 'fail'), findings };
}
