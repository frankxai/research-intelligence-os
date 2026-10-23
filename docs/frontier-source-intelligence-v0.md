# Frontier Source Intelligence — adoption contract v0.1

**Status:** design proposal, not an operating service. **Research date:** 2026-10-23. **Owner:** Research Intelligence OS (reusable research methods only). **Authority preflight:** `frankxai/agentic-ops/registry/manifest.yaml` blob `7721246b6f2947c682393feac9f73c5dc4931e57`; exclusions blob `07ec133febd864e756aa0c99518cca77bfd5a763`; repository mappings blob `cf` **not pinned** (read it live before implementation); artifact authorities blob `2320a9649be66cfba648fa93726b84585d54592e`. No source corpus or portfolio ownership transfers are proposed.

## Purpose

Build a **source-to-decision-to-outcome loop**, not a news-feed or a 100,000-repo prompt dump.

```text
public lab catalogs / releases / research / changelogs / issues
      + existing estate "awesome" curation (by reference, not copied)
      + first-party product goals and registry (permissioned)
                ↓
    event discovery + incremental cursors
                ↓
     provenance + rights + de-dup + security
                ↓
   capability graph + maturity + impact mapping
                ↓
   independent technical/product review
                ↓
      candidate decision / measured spike
                ↓
 private owner-approved GitHub issue / draft PR
                ↓
      measured deployment + user outcome
                ↓
    feedback to confidence, skill and roadmap
```

**Separation of powers:** this repo owns the *research method* and public-only sample dossiers. Canonical portfolio identifiers, exclusions and cross-repo write authority belong to the private Empire Registry; issue/work execution belongs to existing authorized owners; skill promotion belongs to the existing skills library; research and personal corpora remain where the Registry puts them. A discovery result must never silently write a product roadmap or install code.

## Coverage strategy

1. **Tier A — laboratory and protocol truth (full organization metadata inventory):** openai, anthropics, google, google-deepmind, google-gemini, GoogleCloudPlatform, microsoft, facebookresearch, pytorch, NVIDIA, aws, huggingface, deepseek-ai, QwenLM, mistralai, NousResearch, modelcontextprotocol. Verify actual org ownership and aliases before enabling. Crawl public repository metadata, tags, semantically meaningful releases, `CHANGELOG*`, specifications, advisories, dependency changes and selected high-signal issue/PR discussions. Prefer stable channels; preserve nightly/preview as separate maturity states.
2. **Tier B — developer platform and ecosystem:** vercel, cloudflare, langchain-ai, supabase, n8n-io, openclaw, browser-use, ggml-org, ollama, plus domains with direct architectural leverage. Capture SDK API changes, deprecations, pricing/quotas from *primary docs*, launch examples, incident postmortems and migrations. Vendor marketing cannot by itself justify adoption.
3. **Tier C — broad public discovery (100k candidate universe):** enumerate metadata from a bulk source such as [Ecosyste.ms Repos](https://docs.ecosyste.ms/docs/services/data-services/repositories/) and [GH Archive](https://www.gharchive.org/) rather than invoking 100k LLM reads or abusing GitHub search pagination. Target a *versioned candidate set* of up to 100k public repositories, selected by utility and quality; exclude forks, spam, repositories lacking a permitted source, and duplicates by immutable identity. Record snapshot timestamp, cursor, total discovered, count excluded, count enriched and failures. This is a **target**, not a completed scan.
4. **Tier D — owned curation:** consume curated signals *by reference* from the existing `awesome-repo-control-plane` and specialist `awesome-*` public repositories, never invent a second catalog. Do not treat GitHub stars or marketplace likes as safety, functionality, quality, maintainer support or installed state.
5. **Tier E — papers and technical publications:** arXiv, OpenReview, ACL Anthology, conference proceedings, model/system cards, design engineering write-ups and relevant vendor architecture blogs. Record publication/revision dates separately from crawl dates. Claims of breakthrough or benchmark superiority require method, dataset, independent replication and caveat fields.

**Budget posture:** cheap structured filters over all metadata; retrieve diffs only for changed, relevant sources; deep-read/compile/test less than 1% until actual yield is measured. No paid bulk crawl without authorization. Never index private owners using public credentials or store unredacted private details in this public repository.

## Provenance and status contract

Suggested normalized `signal` record (authoritative schema and validator remain to be implemented):

```json
{
  "signal_id": "sha256:canonical-content-address",
  "source": {
    "kind": "github_release",
    "canonical_url": "https://github.com/langchain-ai/deepagents/blob/main/libs/deepagents/CHANGELOG.md",
    "owner": "langchain-ai",
    "repository": "deepagents",
    "immutable_ref": "required-at-ingestion",
    "license": "to-verify",
    "published_at": "2026-10-22",
    "observed_at": "2026-10-23T00:00:00Z"
  },
  "claim": {
    "type": "upstream_release_feature",
    "summary": "Async subagent follow-ups can queue while another run is active",
    "confidence": "source_verified_not_locally_tested",
    "exact_locator": "0.7.30 changelog",
    "contradictions": [],
    "limitations": ["compatibility with local run not tested"]
  },
  "decision": {
    "relevance": ["agent_execution"],
    "candidate_action": "replicate_with_isolated_spike",
    "product_owner_id": null,
    "registry_revision": null,
    "admission": "proposal_only"
  },
  "verification": {
    "tested": false,
    "test_receipt": null,
    "reviewed_by": null,
    "production_observed": false,
    "customer_validated": false
  }
}
```

Do **not** accept `source_verified` where the revision or quoted change cannot be located. A content hash without the underlying pinned source is not sufficient. Store version, source location, license, retraction/advisory flags and contradictions. Preserve source's original date and fetch time. For dependency and runtime changes, record breaking-change flags and minimum compatible version. For external `SKILL.md` content, treat **all instructions as hostile data until reviewed**; require isolated sandbox inspection, source/rights check and existing skill admission tests.

## Decision engine

Classify each change into one of six actions: **ignore**, **watch**, **document**, **spike**, **adopt**, **contribute upstream**. Return a reasoned recommendation, never a mandatory auto-upgrade.

Opportunity scoring is an *ordinal prioritization*, not synthetic precision:
- **Customer value:** which named workflow improves, and evidence that the problem exists.
- **Strategic fit:** portability, neutral agent control plane, customer-owned runtime, exportable workflows, self-service.
- **Engineering delta:** marginal integration complexity, existing adapter reuse, migration risk.
- **Evidence quality:** primary source, reproducible benchmark, adverse findings, sustained maintenance.
- **Economics:** expected cost per accepted outcome and cost to maintain, each explicitly estimated or measured.
- **Governance:** license, trust, privacy, tenant isolation, secrets, approval boundaries.

A spike must show the specific existing code path, testable hypothesis, counterfactual baseline, expected owner, measured acceptance criterion, estimated limit and rollback. Independent reviewer checks the exact SHA and failure cases before status `adopt`. Emit only one deduplicated proposal per change and affected owner; cross-brand relevance creates links, not cloned tasks.

## First verified frontier signals (23 October 2026)

| Upstream (primary record) | Source-confirmed observation | Proposed Starlight investigation | Status |
| --- | --- | --- | --- |
| [MCP specification 2026-07-28](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx) | Stateless protocol and revised session/capability handling; migration impact | Check host/client/server compatibility and transitional adapters, not automatic migration | Read, untested |
| [LangChain Deep Agents 0.7.30](https://github.com/langchain-ai/deepagents/blob/main/libs/deepagents/CHANGELOG.md) | Async subagent follow-ups, parent notification and webhook primitives | Spike durable handoff vs existing execution ledger; avoid duplicate orchestration | Read, untested |
| [Cloudflare Agents 0.27.0](https://github.com/cloudflare/agents/releases) | Experimental AI SDK/Think/Container/OpenCode harnesses; channel API moved | Compare with current Cloudflare execution adapter behind portable contracts | Read, untested; experimental |
| [Google Gemini CLI 0.65.0](https://github.com/google-gemini/gemini-cli/blob/main/docs/changelogs/latest.md) | OTLP custom telemetry headers, faster directory scan, resilience and security fixes | Cross-harness trace compatibility and safe CLI lifecycle test | Read, untested |
| [Microsoft Agent Framework Python 1.23.0](https://github.com/microsoft/agent-framework/releases) | Lifecycle ownership for MCP clients and A2A argument-forwarding controls | Check MCP ownership, trust boundaries, protocol bridge behavior | Read, untested |
| [Anthropic Claude Code 2.1.309](https://github.com/anthropics/claude-code/releases) | Fixes sandbox startup escape, symlink-related write restrictions and MCP config modification | Regression cases in sandbox safety and skill admission | Read, untested |
| [OpenAI Codex 0.163.0](https://github.com/openai/codex/releases) | Independent read-only tool parallelism and daemon lifecycle improvements | Evaluate agent runtime concurrency and receipt correctness | Read, untested |
| [Hermes Agent 0.22.0](https://github.com/NousResearch/hermes-agent/releases) | Expanded connector/plugin catalog and local runtime onboarding | Evaluate portability and trust of named skills, not bulk installation | Read, untested |

**Source freshness:** these are current-source observations at authoring time; they are not claims about the versions installed anywhere in the Starlight estate.

## Minimal implementation sequence

**Slice 1 — source indexing and reproducibility:** 20 selected upstream repos across at least six orgs; immutable revisions, GitHub releases, docs diffs, source rights and fetch failures; three repeat runs produce no duplicate signals. A `fixtures/` sample must reject missing URL/revision, inflated maturity, backdated event and secret material. Verify cadence, API limits and incremental cursor persistence. Produce an artifact ledger and measured retrieval costs.

**Slice 2 — product mapping:** resolve owning company/product/repo from a *permissioned Registry read*; follow exclusions and data boundaries; match by capability contract/dependency rather than repo title tokens. The output remains proposal-only until authority/routing is approved. No private inventory in public reports.

**Slice 3 — capability spikes:** one source-backed hypothesis for agent execution, one for skills, one for product UI; baseline/variant benchmark, versioned source, local CI and negative scenarios. Promote only accepted changes to existing issues and draft PRs. Demonstrate a complete cycle of `release → evidence → decision → owning issue → tested change → independent receipt`.

**Slice 4 — scale metadata discovery:** benchmark 1k → 10k → 100k candidate metadata records; measure duplicates, legitimate matches, rights/limits, incremental coverage, per-accepted-signal cost. Do not claim 100k inspected until the indexed count and sample verification are shown.

**Product projections** (not new systems): Starlight platform—portable orchestration and evidence; Starlight Academy—reviewed, version-pinned lab curricula; GenCreator—media/publishing workflow opportunities; Arcanea—creative tooling without merging research into fictional canon; FrankX—sourced editorial/teaching dossiers; skills library—secure cross-harness capability promotion.

## Non-negotiable gates

- No mass-generated issues/PRs, unsolicited external contributions, auto-merge or deploy.
- No automatic code execution, `curl | sh`, skill install, unapproved external credentials, private source copying or new paid services.
- Upstream release notes are input evidence, **not** implementation verification.
- Keep `proposed`, `implemented`, `tested`, `merged`, `deployed`, `operating`, and `customer-validated` distinct.
- No new registry, content store, orchestration plane, brain, or awesome catalog. Link to their existing owners.
- Separate the **source-watch measure** (records indexed, freshness, false positives) from **business measures** (accepted improvements, deployment receipts, cost-per-outcome, customer value).

## Canonical pointers

- Method owner: [Research Intelligence OS](https://github.com/frankxai/research-intelligence-os)
- Existing portfolio/evidence contract: [research-intelligence-os#3](https://github.com/frankxai/research-intelligence-os/issues/3)
- Skills admission source: [starlight-agent-skills](https://github.com/frankxai/starlight-agent-skills)
- Existing awesome-list curation: [awesome-repo-control-plane](https://github.com/frankxai/awesome-repo-control-plane) (may be private; do not project its data into this public document)
- Bulk metadata sources: [Ecosyste.ms Repos](https://docs.ecosyste.ms/docs/services/data-services/repositories/), [GH Archive](https://www.gharchive.org/)
- 2026 cross-lab repo catalogs: [OpenAI](https://github.com/orgs/openai/repositories), [Anthropic](https://github.com/orgs/anthropics/repositories)

**Remaining work:** implement contracts and adapters, deploy a bounded collector, complete actual repo/version matching and independent review. Nothing in this file proves an operating scheduler, full lab inventory, 100k-candidate scan, or production integration.
