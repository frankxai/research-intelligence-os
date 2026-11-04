// Pure functions for the research corpus pipeline. No I/O here, so every rule is testable.

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
      domain: kind === 'personal' ? null : routeDomain(file.title, domains),
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
export function frontMatter(entry, exportedAt) {
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
// and the first reading after it finished (a 'done' record). Overlapping runs are skipped
// because their cost cannot be separated.
export function usagePlan(ledger) {
  const rows = [...ledger].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const readings = rows.filter((r) => r.type === 'reading');
  const costs = [];
  for (const run of rows.filter((r) => r.type === 'run')) {
    const done = rows.find((r) => r.type === 'done' && r.title === run.title && r.ts >= run.ts);
    if (!done) continue;
    const overlaps = rows.some((r) => {
      if (r.type !== 'run' || r === run) return false;
      const rDone = rows.find((d) => d.type === 'done' && d.title === r.title && d.ts >= r.ts);
      return r.ts < done.ts && (!rDone || rDone.ts > run.ts);
    });
    const before = readings.filter((r) => r.ts <= run.ts).at(-1);
    const after = readings.find((r) => r.ts >= done.ts);
    if (overlaps || !before || !after) continue;
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
