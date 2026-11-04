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
| `node corpus.mjs list` · `classify` · `export` | Drive listing → inventory (kind, domain, re-run dedupe, personal exclusion) → markdown export. A Deep Research title that contains no `domains.json` keyword is routed by the words of a multi-word keyword it shares (two words and two thirds of the phrase, at least one of them topic-specific rather than a generic word such as pricing, product, code or review, one domain clearly ahead); otherwise it stays `unrouted` |
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

A report is trusted claim by claim, not as a document. `verify sample <key> [--n 10] [--from auto|table|prose|all]` takes a corpus key (a `.md` report), reads the report's claims table (or, without one, sentences that end in a citation; `--from all` takes both), maps glued citation numbers to the Works cited list, and draws a sample. It writes three files under `RESEARCH_HOME/verify/` and nowhere else:

- `<domain>__<report>.claims.jsonl`, the records the checker edits (schema `claim-evidence/v1`: claim, source URL, report's date, excerpt, source's own date, status, contradictions);
- `<domain>__<report>.checklist.md`, the same claims for reading;
- `<domain>__<report>.manifest.json` (schema `claim-sample/v1`), written once and never edited by the checker: the report key, the report digest (body and front matter, minus the `exported`, `imported` and `generated` timestamps), the seed, the size, the mode, the sampled claim ids in order, and a self-hash.

Reports are read with CRLF and lone CR line endings turned into LF first, so extraction, the release minimum and the digest are the same whichever line endings a file was saved with. The seed is derived from the report digest, so nobody chooses it; `--seed` is refused. Claim ids are the full SHA-256 of the claim text and its sources. A sample smaller than the release minimum (10 claims, or every claim in a shorter report, counted across all modes so a narrow `--from` cannot lower it) is refused. Deterministic signals come first: `spacing-lost` (the export dropped spaces between dollar signs, so numbers are suspect), `url-not-in-works-cited`, `ref-differs-from-source-url`, `no-source`.

A checker that did not write the report fetches each source and sets `status` to `verified`, `partial`, `unsupported`, `contradicted`, `garbled` or `unreachable`, and fills `checker` and `checked_at`; `verified`, `partial` and `contradicted` also need a verbatim `excerpt` and a source URL the report cites, so a claim flagged `no-source` can only be `unsupported`, `garbled` or `unreachable`. `source_date` is recorded when the source has one and is not required. The checker edits only `status`, `excerpt`, `source_date`, `contradictions`, `checked_at`, `checker`, `method` and `notes`.

`verify score <key>` takes the sample's parameters and claim ids from the manifest alone. It blocks release when there is no manifest, when the manifest's self-hash, report key or seed derivation is wrong, when the report's current digest differs from the manifest's (any body or provenance change, such as `source_id` or `verification`: resample with `--force`), when the manifest's ids are not what the report yields for that size and mode, when the sample is below the release minimum, when the claims file does not hold exactly the manifest's claims once each, or changes any field but the checker's (the seed, size, mode and digest written in each record are informational and must agree with the manifest), when a record names another report, when a checked record lacks its evidence, on any contradicted claim, on more than 20% unsupported, contradicted or garbled, on more than 30% unreachable, or on unchecked claims. It exits 1 unless the release passes, so `verify score <key> && …` stops on a block. The thresholds are starting hypotheses.

### Threat model

The gate stops accidents and agent shortcuts: a checker that edits a claim, copies a verdict across rows, trims or pads the file, re-draws the sample with an easier seed or a narrower mode, swaps in another report's file, or keeps verdicts after the report or its provenance changed. It does not stop someone who deliberately rewrites both the claims file and the manifest: both live in the same private folder, and the self-hash is not a signature (anyone can recompute it). Real tamper evidence needs a record the checker cannot rewrite, for example an append-only hash chain of manifests in a ledger kept elsewhere, or a receipt signed with a key the checker does not hold. That is future work; until then a `pass` means "consistent and complete", not "proven untouched".

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
4. `usage plan` returns the mean weekly and window percent per run, runs left this window and week, and runs per week. A run is measured only when it is the only run between its two readings, and not when any reading from the first to the second shows a meter fall or announces a session or weekly reset before the second, so take a reading between runs until you have three measured runs.
5. A run that stalls or ends without a report: `usage abandon --title "<topic>" --at <ISO time it stopped>`. Until it is closed, every later run counts as overlapping it and cannot be measured.

`done` and `abandon` refuse a title that matches no open run at that time and list the runs that are open, so a typo cannot leave the real run open.

## NotebookLM

There is no NotebookLM API for consumer or Ultra accounts; the Enterprise API (Google Cloud, alpha) is the only official one, and unofficial clients need browser cookies, which this estate does not export. NotebookLM reads Drive Docs directly: one notebook per domain with the exported reports as sources.

## Deep Research prompts

`deep-research-prompts.md`: a shared frame and one block per domain, asking for dated primary sources, a claims table and a split between facts, forecasts and opinions.
