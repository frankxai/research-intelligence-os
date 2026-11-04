# Research corpus pipeline

Turns Gemini Deep Research reports, estate documents and live model catalogs into one searchable corpus that cloud agents and local CLI agents query the same way. Every new Claude Code session also starts with a brief: newest models, newest research, research that is due.

```text
 Google Drive (Deep Research)   estate / repo docs     provider model APIs
        │ rclone drive.readonly       │ import              │ brief
        ▼                             ▼                     ▼
   ~/.starlight/research/corpus/<domain>/*.md   (front matter: source, commit, kind, verification)
        │ push (wrangler r2 object put)
        ▼
   R2 starlight-research-corpus ──/sync──▶ AI Search "starlight-research" (built-in storage, hybrid + rerank)
                                                    │
                                   Worker starlight-research (bearer auth, fail closed)
                       /search · /ask (cited, Workers AI) · /status · /mcp
                         │                    │                         │
                Claude Code (HTTP MCP,   Codex / Grok / Gemini CLI   starlight-agents plane
                 headersHelper)          (stdio mcp-bridge.mjs)      (service binding, next)
```

## Why these choices

- **AI Search, created by the Worker's namespace binding.** `wrangler ai-search create` demands an AI Search service token for both R2 and built-in instances. A Worker with an `ai_search_namespaces` binding creates a built-in instance at runtime with no token, then copies R2 objects in through the Items API. AI Search handles chunking, embeddings, hybrid keyword and vector search, and reranking.
- **R2 stays the source of record** for the corpus; AI Search is a derived index that `/sync` rebuilds from it (`_sync/state.json` tracks etags). The `starlight-agents` Worker keeps its own `starlight-evidence` Vectorize index for mission evidence.
- **One Worker, many clients.** HTTP MCP for clients that support auth headers, a stdio bridge for those that don't, plain HTTP for scripts and Workers.
- **Code public, corpus private.** This repository is public. Titles, IDs and contents live in `~/.starlight/research` and the private bucket. The Worker refuses every request without the bearer token; `/health` reveals nothing.
- **Provenance on every document.** Deep Research and Gemini write-ups carry `verification: unverified-ai-synthesis`; local files carry their path and the commit they were read at, or `working-tree-draft` when uncommitted; model catalogs carry `measured-from-provider-api`. Answers from `/ask` cite source keys and repeat the label.

## Commands

| Command | Does |
|---|---|
| `node corpus.mjs list` · `classify` · `export` | Drive listing → inventory (kind, domain, re-run dedupe, personal exclusion) → markdown export |
| `node corpus.mjs import <f.md>... --domain <id>` | brings local or repo docs in with path and commit provenance |
| `node corpus.mjs push` | uploads changed files to R2 and triggers `/sync` |
| `node corpus.mjs sync` · `status` | Worker: copy R2 into AI Search · indexing state per item |
| `node corpus.mjs search "<q>" [--domain id] [--local]` | ranked passages with source keys (Worker, or local BM25 when `--local` or no token) |
| `node corpus.mjs ask "<q>" [--domain id]` | cited answer (model: `ANSWER_MODEL` in `worker/wrangler.jsonc`) |
| `node corpus.mjs triage summary\|apply` · `audit` · `prune` | reviewer verdicts and quarantine · evidence tally · remove local copies no longer in the inventory |
| `node corpus.mjs eval [--file q.json]` | hit@1, hit@5, MRR of local BM25 on `eval/questions.json`; a vector index must beat it |
| `node corpus.mjs verify sample <key> [--n 10] [--seed S]` · `verify score <key>` | claim-level evidence records for a report, then the tally and release verdict (below) |
| `node corpus.mjs doctor [--skip check]` | silent-failure checks (below); exit 1 on any `fail` |
| `node corpus.mjs brief` | session brief plus `_platform/latest-models.md` catalog in the corpus |
| `node corpus.mjs queue` | domains whose newest Deep Research report is past its window |
| `node corpus.mjs usage reading\|run\|done\|abandon\|plan\|show` | Gemini Deep Research usage ledger (below) |

Tests: `node --test lib.test.mjs`.

## Claim verification

A report is trusted claim by claim, not as a document. `verify sample` takes a corpus key (a `.md` report), reads the report's claims table (or, without one, sentences that end in a citation), maps glued citation numbers to the Works cited list, and writes a seeded sample to `RESEARCH_HOME/verify/<domain>__<report>.claims.jsonl` (schema `claim-evidence/v1`: claim, source URL, report's date, excerpt, source's own date, status, contradictions, and `report_sha256`, the digest of the report body the claims came from) plus a readable checklist. It never writes anywhere else. Deterministic signals come first: `spacing-lost` (the export dropped spaces between dollar signs, so numbers are suspect), `url-not-in-works-cited`, `ref-differs-from-source-url`, `no-source`.

A checker that did not write the report fetches each source and sets `status` to `verified`, `partial`, `unsupported`, `contradicted`, `garbled` or `unreachable`, and fills `checker` and `checked_at`; `verified`, `partial` and `contradicted` also need a verbatim `excerpt`. `source_date` is recorded when the source has one and is not required. `verify score` re-reads the report and blocks release when the report is missing or its body changed since sampling (resample with `--force`), when records are missing or duplicated, when a checked record lacks its evidence, on any contradicted claim, on more than 20% unsupported, contradicted or garbled, on more than 30% unreachable, or on unchecked claims. It exits 1 unless the release passes, so `verify score <key> && …` stops on a block. The thresholds are starting hypotheses.

## Scheduled refresh

`scheduled-run.ps1` (staged, not registered) runs `list`, `classify`, `export` and `doctor` one step at a time with a per-step timeout and a lock, stops at the first failure, logs to `RESEARCH_HOME/runs/` and writes `runs/last-run.json`. An invocation that finds the lock held only logs the skip, so `last-run.json` keeps describing the run that holds the lock. `-DryRun` prints the plan. `register-daily.ps1` registers it with the session brief after it, and the task exits with the refresh's failure code even when the brief succeeds; the owner runs that.

`doctor` fails on a quarantine leak (a corpus file whose Drive id is excluded or whose key is in `quarantine/`), on a failed last run and on a run still `running` past the 75-minute scheduler limit; it warns on a corpus title that matches a quarantined one, a Drive listing older than 36 h, runs logged without `done`, a stale or full usage window, and a missing run.

## Clients

**Claude Code** (user scope, all projects):

```text
claude mcp add-json starlight-research '{"type":"http","url":"https://starlight-research.frankxai.workers.dev/mcp","headersHelper":"pwsh -NoProfile -File C:/Users/frank/.starlight/research/mcp-headers.ps1"}' --scope user
```

The header helper reads the token from `worker-secrets.env` at connect time, so no config file holds it.

**Codex, Grok CLI, Gemini CLI, Hermes**: run `mcp-bridge.mjs` as a stdio server (installed copy at `~/.starlight/research/bin/mcp-bridge.mjs`). Codex:

```toml
[mcp_servers.starlight-research]
command = "node"
args = ["C:/Users/frank/.starlight/research/bin/mcp-bridge.mjs"]
```

Tools: `research_search`, `research_ask`, `research_read`, `research_list`.

## Worker

`worker/` deploys with `wrangler deploy` (first deploy: `wrangler deploy --secrets-file ~/.starlight/research/worker-secrets.env`). Rotate the token by writing a new value to that file and running `wrangler secret put RESEARCH_TOKEN` with it; every client reads the file, so nothing else changes.

## Remaining one-time setup

1. `rclone config create gdrive drive scope=drive.readonly` (Google sign-in, read-only) to export Deep Research reports in bulk.
2. Optional: `pwsh -File register-daily.ps1` registers the daily refresh (`scheduled-run.ps1` then `brief`; staged, not registered).

## Session brief

A Claude Code SessionStart hook prints `~/.starlight/brief/session-brief.md`, so a new session knows the newest Workers AI and Vercel AI Gateway models (from their live catalogs, ranked by `released`), the newest research, the due domains and today's Deep Research usage, without a network call at start-up.

## Gemini usage

Gemini Ultra meters usage in percent, not runs: `gemini.google.com/usage` shows a rolling window ("Current usage", resets in about five hours) and a weekly limit. Third-party per-day counts (120, 200) are not what the app enforces. The ledger measures the real cost per run:

1. Before a run: read the Usage limits page (neo helper `readUsage`) and `node corpus.mjs usage reading --session P --weekly P --session-resets "HH:MM" --weekly-resets "D Mon HH:MM" --shot <file>`.
2. Start it: `usage run --domain <id> --title "<topic>"` (the title is required: it is how the run is closed).
3. When it finishes: `usage done --title "<topic>"`, then another `usage reading`.
4. `usage plan` returns the mean weekly and window percent per run, runs left this window and week, and runs per week. A run is measured only when it is the only run between its two readings, and not when a meter fell or the window's reset time passed between them, so take a reading between runs until you have three measured runs.
5. A run that stalls or ends without a report: `usage abandon --title "<topic>" --at <ISO time it stopped>`. Until it is closed, every later run counts as overlapping it and cannot be measured.

`done` and `abandon` refuse a title that matches no open run at that time and list the runs that are open, so a typo cannot leave the real run open.

## NotebookLM

There is no NotebookLM API for consumer or Ultra accounts; the Enterprise API (Google Cloud, alpha) is the only official one, and unofficial clients need browser cookies, which this estate does not export. NotebookLM reads Drive Docs directly: one notebook per domain with the exported reports as sources.

## Deep Research prompts

`deep-research-prompts.md`: a shared frame and one block per domain, asking for dated primary sources, a claims table and a split between facts, forecasts and opinions.
