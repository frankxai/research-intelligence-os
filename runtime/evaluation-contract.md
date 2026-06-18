# Evaluation Contract (Research Intelligence OS)

## Purpose

Defines how agent outputs are scored for quality, trustworthiness, and usefulness.
Every evaluation in this swarm uses this contract. Evaluators (human or agent) must
produce scores in the format defined here so results are comparable across domains,
agents, and pipeline runs.

---

## 1. When to Evaluate

Evaluation runs at three points in a research pipeline:

| Trigger | What is evaluated | Who evaluates |
|---|---|---|
| **Step gate** | Output of a single agent before it feeds the next | Automated checks |
| **Pipeline exit** | Final pipeline output before delivery | Evaluator agent or human |
| **Retrospective audit** | Any prior run, on demand | Human or senior eval agent |

Step-gate evaluation is mandatory. Pipeline-exit and retrospective evaluation are
configured per pipeline in `pipeline-contract.md`.

---

## 2. Evaluation Input

An evaluator receives:

```yaml
EvalRequest:
  output: ResearchOutput           # the agent output being scored (see agent-contract.md)
  task: ResearchTask               # the original task the agent was given
  eval_criteria: []                # criteria the agent declared in its task
  context:
    prior_outputs: []              # upstream outputs in the same pipeline run
    domain: string
    ground_truth: null | {}        # if available (e.g., known literature benchmarks)
```

The evaluator must not access information the agent could not have accessed.
(No oracle scoring unless `ground_truth` is explicitly provided.)

---

## 3. Evaluation Output

Every evaluator emits an `EvalResult`:

```yaml
EvalResult:
  task_id: string                  # same as the output being evaluated
  agent_id: string                 # the agent being evaluated
  evaluator_id: string             # who/what ran this evaluation
  timestamp: ISO-8601

  scores:
    epistemic_honesty: 0.0–1.0     # are claims backed by traceable evidence?
    scope_discipline: 0.0–1.0      # did the agent stay in its role?
    reproducibility: 0.0–1.0       # can the steps be replayed?
    completeness: 0.0–1.0          # did the agent address the full task?
    calibration: 0.0–1.0           # are confidence values accurate?
    overall: 0.0–1.0               # weighted composite (weights below)

  flags: []                        # specific issues that warrant human review
  verdict: "pass" | "warn" | "fail"
  notes: string                    # brief evaluator rationale (required on warn/fail)
```

---

## 4. Scoring Dimensions

### 4.1 Epistemic Honesty (weight: 0.30)

**What it measures:** Are claims supported by traceable evidence?

| Score | Meaning |
|---|---|
| 1.0 | Every claim has a traceable source or is marked `synthesized` |
| 0.7 | Minor claims lack citations but are flagged in `gaps` |
| 0.4 | Multiple uncited claims; `gaps` understates the problem |
| 0.0 | Citations are fabricated or the agent asserts with no basis |

Automatic check: cross-reference `findings[].evidence` against any provided
`ground_truth` or search-result logs. Flag mismatches.

### 4.2 Scope Discipline (weight: 0.20)

**What it measures:** Did the agent do only what its role permits?

Score 1.0 when findings map cleanly to the agent's declared `role`.
Deduct 0.2 per finding that belongs to a different agent role.
Score 0.0 when the agent's output is primarily outside its role.

### 4.3 Reproducibility (weight: 0.20)

**What it measures:** Can another agent or human replay this output?

Check:
- All tool calls logged with params and rationale
- Prompt template version recorded
- No implicit steps ("I then searched…" without a TOOL_CALL block)

Score degrades proportionally with the number of unlogged steps.

### 4.4 Completeness (weight: 0.15)

**What it measures:** Did the agent address everything in the task?

Compare `ResearchTask.query` fields against `ResearchOutput.findings` coverage.
Any uncovered required field that is not documented in `gaps` is a completeness miss.

### 4.5 Calibration (weight: 0.15)

**What it measures:** Are the agent's `confidence` values trustworthy?

This is the hardest dimension to score automatically without ground truth.

When ground truth is absent:
- Check internal consistency: high-confidence claims must have more evidence items
  than low-confidence claims.
- Check for confidence inflation: if `overall confidence > 0.8` but `citation_count < 2`,
  flag for human review.

When ground truth is available:
- Compare agent `confidence` against observed accuracy on known cases.
- Calibration score = 1 − mean(|predicted_confidence − binary_correct|).

---

## 5. Overall Score and Verdict

```
overall = (0.30 × epistemic_honesty)
        + (0.20 × scope_discipline)
        + (0.20 × reproducibility)
        + (0.15 × completeness)
        + (0.15 × calibration)
```

| Overall | Verdict | Pipeline behavior |
|---|---|---|
| ≥ 0.80 | pass | Continue to next step |
| 0.55–0.79 | warn | Continue but flag for human review |
| < 0.55 | fail | Block pipeline; request agent retry or human override |

A single dimension scoring 0.0 forces `verdict: "fail"` regardless of overall,
because a zero on any dimension represents a systemic failure mode, not a minor gap.

---

## 6. Flags

Flags are named, machine-readable markers added to `EvalResult.flags`:

| Flag | Meaning |
|---|---|
| `FABRICATED_CITATION` | Evidence item does not exist or is fabricated |
| `SCOPE_VIOLATION` | Finding belongs to a different agent role |
| `UNLOGGED_STEP` | A processing step has no tool-call log |
| `CONFIDENCE_INFLATION` | High confidence with thin evidence |
| `CONTRADICTION_UNRESOLVED` | A contradiction from `agent-contract §4.1` was not surfaced |
| `EMPTY_GAPS` | Agent emitted `gaps: []` on a `partial` or low-confidence run |
| `TASK_MISMATCH` | Output does not address the input query |

Any flag triggers human review regardless of `verdict`.

---

## 7. Evaluator Agents

An evaluator is itself an agent and must declare its identity (see `agent-contract.md §1`).
Its role is `evaluator` and its domain is the domain of the pipeline it evaluates.

Evaluator agents must not:
- Access information the evaluated agent could not have accessed
- Score their own output (no self-evaluation)
- Modify the output they are scoring

Multi-agent chains may use a dedicated evaluator per step or a single evaluator
at the pipeline exit. The pipeline contract declares which pattern is in use.

---

## 8. Human Override

A human may override any `verdict` by:

1. Adding an `override` block to the `EvalResult`:

```yaml
override:
  by: "<name>"
  timestamp: ISO-8601
  new_verdict: "pass" | "warn" | "fail"
  rationale: string
```

2. Original scores are never changed — only the `verdict` field.

Human overrides are auditable. They are never silent.

---

## 9. Retrospective Audit

A retrospective audit takes a completed pipeline run and re-evaluates every agent
output in sequence. It is used when:

- New ground truth becomes available
- A downstream finding is retracted
- A domain pack is upgraded and prior runs need re-scoring

Retrospective audits emit `EvalResult` objects with `evaluator_id` prefixed `retro:`.

---

## See Also

- `agent-contract.md` — what agents must emit for evaluation to work
- `pipeline-contract.md` — how evaluation integrates into pipeline flow
- `templates/research-skill/SKILL.md` — how skills declare their own eval criteria
