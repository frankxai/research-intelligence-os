# Research Intelligence OS

**The reusable implementation layer for building domain-specific research intelligence systems.**

Research Intelligence OS provides the runtime scaffolding, contracts, templates, and evaluation layer that powers the entire research portfolio.

## Purpose
Enable rapid, consistent, high-quality development of research agents, skills, and workflows. It is the "engine" that domain systems (psychology, neuroscience) and the broader portfolio build upon.

## How People Experience It
Builders (researchers or agent developers) use the runtime to:
- Scaffold new agents with templates/research-agent.agent.md
- Implement skills following research-skill/SKILL.md
- Execute pipelines with defined contracts
- Evaluate with evals/

Typical experience: Clone template → customize with domain pack → run via runtime contracts → evaluate reproducibility.

## How Agents Explore It
- research-os.yaml
- runtime/ (pipeline-contract.md, agent-contract.md, evaluation-contract.md)
- templates/ (research-agent.agent.md, research-skill/SKILL.md, evidence-table.md, reproducibility-report.md)
- scripts/ and evals/
- Integrates with all packs and human-mind models.

**Example Prompt**:
"Using research-os runtime contracts and evaluation-contract.md, implement a new skill for [domain] following the template. Ensure structured outputs per schemas. Reference latest best tech for reproducibility."

## Usefulness
- **Humans**: Dramatically speeds up creating reliable research tools.
- **Agents**: Provides clear contracts so agents from different domains interoperate.
- **Integrations**: The foundation for Psychology RIS, Neuroscience RIS, and custom systems.
- **Latest Best Tech**: ReAct + tool calling patterns, strict JSON Schema contracts, containerized reproducibility, LLM-as-judge evals, modern evaluation frameworks.

See research-os.yaml, runtime/, templates/, evals/, AGENTS.md, HERMES.md, EXPERIENCE.md.

This is the engineering core enabling excellence across the swarm.