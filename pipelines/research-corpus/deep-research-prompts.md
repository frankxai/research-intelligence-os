# Deep Research prompt library

Prompts for Gemini Deep Research, one per expert domain in `domains.json`. Each one produces a report that the corpus pipeline can index and that an agent can cite claim by claim.

## How to run one

1. `node corpus.mjs queue` lists the domains past their freshness window. Pick the top `DUE` row.
2. Paste the shared frame below, then the domain block, into Gemini with **Deep Research** selected. Replace `{{DATE}}` with today's date.
3. Read the research plan Gemini proposes before you start it. Edit the plan if it drifts toward generic overviews. Steering the plan improves the report more than anything else you do.
4. When the report finishes, use **Export to Docs**. Keep the title Gemini suggests, or start it with the domain name.
5. Log the run: `node corpus.mjs usage run --domain <id> --title "<topic>"`.
6. Every few runs, read the remaining count in the Gemini app and record it: `node corpus.mjs usage snapshot --remaining <N>`.
7. Refresh the corpus: `node corpus.mjs list && node corpus.mjs classify && node corpus.mjs export && node corpus.mjs push`.

## Shared frame (paste first, every time)

```text
Today is {{DATE}}. You are researching for a small studio that builds and sells digital products with AI agents. The report will be split into passages and retrieved by other AI agents, so structure matters as much as content.

Rules for the report:
- Cover only what changed or held up in the last 90 days unless I ask for history. Label anything older than 12 months as background.
- Prefer primary sources: official docs, changelogs, release notes, filings, maintainer posts, on-chain or repository data. Use press coverage only to find primary sources.
- Every quantitative claim carries its source and the date that source was published. If two sources disagree, report both and say which is more authoritative and why.
- Separate measured facts from forecasts and opinions. Mark forecasts "Forecast:" and opinions "View:".
- Do not invent numbers, products, people or quotes. If something is unknown, write "Unknown" and say what would settle it.

Structure:
1. Summary: the five findings that would change a decision, one paragraph each.
2. Current state: the landscape as of {{DATE}}, by sub-area.
3. What changed in the last 90 days, dated.
4. Claims table: claim | evidence | source URL | source date | confidence (high/medium/low).
5. Opportunities for a small AI-native product studio, each with the evidence behind it.
6. Risks and open questions.
7. Sources: full list with publication dates.
```

## Domain blocks

### ai-models-platforms (window 7 days)

```text
Topic: the frontier of AI models and agent runtimes as of {{DATE}}.
Cover: new and updated models from Anthropic, OpenAI, Google, xAI, Meta, DeepSeek, Moonshot, Qwen, Mistral and Z.ai, including context window, price per million tokens and stated benchmark results with their sources; which of these run on Cloudflare Workers AI and the Vercel AI Gateway; changes to agent runtimes (Cloudflare Agents and Durable Objects, Vercel Workflows and Sandbox, Claude Agent SDK and Managed Agents, OpenAI Agents SDK); MCP specification changes and notable MCP servers; coding-agent harnesses (Claude Code, Codex, Gemini CLI, Cursor) and what changed in each.
Decision this informs: which model to route each job to, and which runtime capability to adopt next.
```

### github-ecosystem (window 14 days)

```text
Topic: the GitHub ecosystem relevant to AI agent builders as of {{DATE}}.
Cover: the fastest-growing repositories in agent frameworks, MCP servers, agent skills and Claude Code plugins, coding-agent tooling and local models, with star growth over the last 30 days and the measurement source; GitHub platform changes (Copilot agents, Actions pricing and limits, Models, security features); repositories that became de facto standards, and ones that were abandoned or archived; licence changes that matter for commercial reuse.
Decision this informs: which repositories our agents should know deeply, depend on, or contribute to.
```

### digital-product-design (window 30 days)

```text
Topic: digital product design practice as of {{DATE}}.
Cover: how leading product teams design AI-native interfaces (agent UIs, generative UI, chat versus canvas versus command surfaces); design-system practice and tooling (Figma, tokens, code-connected components, AI design tools); onboarding, activation and pricing-page patterns with measured results where published; accessibility requirements now enforced (WCAG 2.2, the European Accessibility Act); named products widely cited as the current bar, and what specifically they do.
Decision this informs: the design standard our products must beat, with named references.
```

### web-design (window 30 days)

```text
Topic: web design and front-end engineering craft as of {{DATE}}.
Cover: Next.js, React and Tailwind releases and what they change; motion and scroll practice (View Transitions, scroll-driven animations, GSAP, Motion) with performance costs; mobile-native web (PWA installability, dvh units, safe areas, iOS behaviour); Core Web Vitals thresholds and how search engines and AI answer engines use them; award-winning sites from the last 90 days (Awwwards, FWA, Godly) and the techniques behind them.
Decision this informs: our front-end stack defaults and the bar for every public page.
```

### marketing (window 21 days)

```text
Topic: marketing and distribution for small digital-product businesses as of {{DATE}}.
Cover: search, answer-engine and generative-engine optimisation (how Google AI Overviews, ChatGPT search, Perplexity and Claude choose and cite sources), with measured studies; creator-led and founder-led distribution on X, LinkedIn, YouTube and newsletters, with platform algorithm changes; marketplace distribution for digital goods (Gumroad, Polar, Whop, Lemon Squeezy, Etsy, Notion and Claude plugin marketplaces), including fees and policy changes; waitlist and launch tactics with published conversion data.
Decision this informs: which channels to invest in next and what each one demands.
```

### community (window 30 days)

```text
Topic: community management for paid and free online communities as of {{DATE}}.
Cover: platforms (Circle, Skool, Discord, Discourse, Slack, Whop) and their pricing, features and policy changes; engagement and retention practice with published benchmarks; how AI is used in moderation, onboarding and member matching, and where it backfired; operator cadences (events, challenges, cohorts) that sustain activity, with named examples; legal and safety duties (moderation, minors, data protection) for an EU-based operator.
Decision this informs: how we run our communities and what to automate safely.
```

### solana (window 14 days)

```text
Topic: the Solana ecosystem as of {{DATE}}.
Cover: protocol and client changes (Firedancer, Agave, SIMDs, fees, throughput) with dates; developer tooling (Anchor, frameworks, SDKs, AI agent kits for Solana); DeFi, payments, stablecoins and consumer apps by measured usage (on-chain data with source); token and NFT standards (Token-2022 extensions, compressed NFTs); regulatory developments affecting Solana products in the EU and US; where AI agents transact or hold wallets on Solana today.
Decision this informs: whether and how our products and agents should integrate with Solana.
```

### ethereum (window 14 days)

```text
Topic: the Ethereum and layer-2 ecosystem as of {{DATE}}.
Cover: protocol upgrades shipped and scheduled, with dates; layer-2 landscape (Base, Arbitrum, Optimism, zkSync, Starknet and others) by measured activity and fees; account abstraction and smart-wallet adoption; developer tooling (Foundry, viem, wagmi, agent wallet SDKs); stablecoins, real-world assets and payments; EU MiCA and US regulatory developments; where AI agents transact on Ethereum today.
Decision this informs: which Ethereum surfaces are worth building on for agent-operated products.
```

### bitcoin (window 21 days)

```text
Topic: the Bitcoin ecosystem as of {{DATE}}.
Cover: protocol and policy debates (soft-fork proposals such as OP_CAT and CTV, relay policy) with current status; Lightning Network capacity, payments adoption and developer tooling; Bitcoin layer-2s and sidechains by measured usage; ETF and institutional flows with sources; Ordinals and other asset protocols; Bitcoin payments for digital goods and for AI agents.
Decision this informs: whether Bitcoin or Lightning payments belong in our product rails.
```

### web3-general (window 21 days)

```text
Topic: cross-chain web3 product trends as of {{DATE}}.
Cover: stablecoin payments and payouts for creators and digital goods; wallets and onboarding (embedded wallets, passkeys); agent-to-agent payments protocols and agent wallets across chains; token-gated communities and memberships that kept members; regulatory status in the EU (MiCA) and US for a small business selling digital products.
Decision this informs: which on-chain features add real value to our products, and which are noise.
```

### publishing-books (window 45 days)

```text
Topic: independent book publishing as of {{DATE}}.
Cover: KDP, IngramSpark, Apple Books and Kobo policy and royalty changes; AI disclosure rules on each platform; what sells in non-fiction business, self-help and AI categories and in fantasy, with measured rank data; audiobook production (AI narration policies); direct sales and pre-order tactics with published results.
Decision this informs: format, platform and launch plan for our books.
```

### music-media (window 45 days)

```text
Topic: AI-assisted music and media production as of {{DATE}}.
Cover: Suno, Udio and other generators, their licensing terms and label agreements; streaming platform policies on AI music (Spotify, Apple Music, YouTube) and royalty rules; distribution services and their AI policies; video generation tools (Veo, Sora, Kling, Runway) for music videos, with pricing and rights terms.
Decision this informs: what we can release, where, and with which rights.
```

### human-potential (window 60 days)

```text
Topic: evidence-based human potential research as of {{DATE}}.
Cover: replicated findings in habit formation, motivation, flow and expertise, with effect sizes and replication status; psychology of human-AI collaboration and dependence; contemplative practice research with study quality noted; claims popular in self-development that failed replication.
Decision this informs: which claims our books and courses may make, and how to word them.
```

### business-strategy (window 30 days)

```text
Topic: funding, compute credits and accelerators for an EU-based AI product studio as of {{DATE}}.
Cover: startup credit programmes (Cloudflare, Google for Startups, AWS Activate, Microsoft, Anthropic, OpenAI, NVIDIA Inception) with current amounts, eligibility and deadlines; accelerators accepting AI-native solo founders, with terms; EU and Dutch grant schemes; how comparable solo studios reached first revenue, with named examples.
Decision this informs: which credits and programmes to apply for this quarter.
```

## Turning reports into other work

A report in the corpus feeds four outputs. Agents draft them; Frank approves anything public.

- **Blog article:** pick one finding from section 5 and write it up with the report's sources. Each claim links its source, not the report. Before it goes public, run the claims audit that the frankx.ai fabrication pattern requires.
- **Agent context:** the session brief lists new reports; agents search the corpus before answering domain questions.
- **NotebookLM notebook:** add the exported Doc as a source in that domain's notebook, for audio overviews and Q&A on the phone.
- **Product decisions:** a finding that changes a build order goes into the owning repo's issue, citing the report's Drive ID.
