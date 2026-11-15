# two-engine-research (staged, not registered)

## Verdict
STAGED. Crons are off until Frank approves; nothing here registers itself.

## Objective
Every topic in the research queue has a Deep Research report from both engines, each report's cited sources are existence-checked, and the vertical dossiers, expert skills and runtime packs are rebuilt from the latest reports, with zero unreviewed sanitiser flags.

## Non-goals
- No installing skills into a harness default prompt (needs an eval first), no publishing packs, no pricing, no external sends.
- No deleting or editing another engine's queue or reports.
- No Gemini runs beyond the plan's usage window; no paid model credits (Perplexity runs only with the Deep Research chip on the default model).

## Actor model
- Worker (this lane): BrowserOS-driven Gemini harvest (`gemini/harvest.mjs`, `state.mjs`), then `gemini/ingest.mjs`, `corpus.mjs push`, `verify-sources.mjs`, `build-verticals.mjs`, `gen-vertical-skills.mjs`, `export-packs.mjs`, `next-wave.mjs --apply`.
- Paired worker: the Perplexity lane (own queue, own harvester).
- Verifier: a non-Claude model or harness (Codex `--profile review`, Grok, or the Starlight Review plane) reads the dossiers and skills read-only and returns PASS / ITERATE / FAIL against GATE below.
- Human gate: sanitiser flags (`review-flags.json`), skill installation, pack publication, anything priced or public.

## Cadence
Once per Gemini usage window (about every 5 hours on Ultra), capped at 15 Deep Research runs per window.

## Gate
```bash
node gemini/state.mjs list                      # no item left in planning or running past 90 min
node verify-sources.mjs                          # repos/papers not-found stay <= 1% of unique sources
node build-verticals.mjs && node next-wave.mjs   # flagged gaps all present in review-flags.json
node --test ../lib.test.mjs                      # import-key and label tests pass
```

## Budgets
- Max Deep Research runs per window: 15. Max windows per day: 3. Stop after the same harvest failure twice.
- RAM: browser work only above the 4 GiB floor; park the tab on about:blank after each read.
- Abort file: create `ABORT` in this directory.

## State
- Queues and ledgers: `RESEARCH_HOME/<engine>/{queue.json,ledger.jsonl,measurements.jsonl}`.
- Gaps: `RESEARCH_HOME/next-wave.json`; triage: `RESEARCH_HOME/review-flags.json`.
- Proof per window: the measurements line with runs started, harvested, words, and usage percent.
