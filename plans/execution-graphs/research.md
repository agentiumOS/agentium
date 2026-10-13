# Execution graphs: bounded research interpretation

Research date: 2026-10-13. Scope: ReAct, OpenHands, and LLMCompiler only. This note contains no Agentium code inventory and makes no claim about guarantees already implemented in Agentium. Paper evidence appears first; subsequent recommendations are engineering judgment for the architecture owner.

The recommended direction is a hybrid: an explicit workflow controls state transitions and contains bounded Agent executions; an Agent may optionally schedule a validated dependency graph of tools. The two graph levels solve different problems. The workflow determines when a stage is complete, what state it may change, and which stage follows. The tool graph determines which already-authorized operations can run together and which results must precede another operation.

## What the papers establish

**ReAct — adaptive behavior inside an agent.** Section 2 describes an agent choosing actions from accumulated observations and actions, augmented by language thoughts. Thoughts update context without changing the environment. Plans can change after observations; the pattern is a sequential decision process rather than a declared dependency scheduler. Section 3.3 also documents repetitive reasoning/action failures and failures after uninformative search. This supports retaining local adaptation without assuming that prompting supplies a reliable termination contract. [ReAct v3, §2](https://arxiv.org/html/2210.03629v3#S2), [§3.3](https://arxiv.org/html/2210.03629v3#S3.SS3).

Reported performance: the paper reports absolute success-rate improvements of 34 and 10 percentage points over its imitation/reinforcement learning comparators on ALFWorld and WebShop. These are benchmark-specific prompting results, not a prediction for an Agentium execution graph. [ReAct v3, §4](https://arxiv.org/html/2210.03629v3#S4).

**OpenHands — separate decisions, history, and execution.** Sections 2.1–2.2 define an agent step consuming state and returning an action, a chronological event stream of actions/observations/user interactions, and a runtime that executes actions and returns observations. State also carries cost and delegation metadata. Section 2.4 represents delegation as an action to another agent. These are useful separation boundaries; they do not themselves define a workflow scheduler. Appendix E uses stored prompt/response matches to make integration tests deterministic. That testing technique should not be mistaken for deterministic production replay or a durable effect protocol. [OpenHands v3, §2.1](https://arxiv.org/html/2407.16741v3#S2.SS1), [§2.2](https://arxiv.org/html/2407.16741v3#S2.SS2), [§2.4](https://arxiv.org/html/2407.16741v3#S2.SS4), [Appendix E](https://arxiv.org/html/2407.16741v3#A5).

Reported evaluation results concern particular agents, models, tasks, and benchmark setups; they do not isolate durable scheduling or recovery correctness. [OpenHands v3, §4](https://arxiv.org/html/2407.16741v3#S4).

**LLMCompiler — dependency scheduling and observation-driven replanning.** Sections 3.1–3.3 describe a planner producing a task DAG with output placeholders, a non-LLM fetching unit resolving inputs and dispatching ready tasks, and asynchronous execution. Tools may themselves be specialized LLM agents. Section 3.4 allows results to trigger a new task graph; §4.2 streams ready tasks before planning finishes. Thus each planning episode can be a DAG while the overall execution contains a replanning cycle. Appendix B records erroneous dependency identifiers and downstream interpretation failures: a schedulable graph can still be wrong. [Published PMLR PDF, §§3.1–3.3, p.4](https://raw.githubusercontent.com/mlresearch/v235/main/assets/kim24y/kim24y.pdf#page=4), [§3.4 and §4.2, p.5](https://raw.githubusercontent.com/mlresearch/v235/main/assets/kim24y/kim24y.pdf#page=5), [arXiv v3, Appendix B](https://arxiv.org/html/2312.04511v3#A2).

Reported maxima include approximately 3.7× latency speedup, 6.7× cost reduction, and 9 percentage points of accuracy improvement over ReAct across the paper's tested workloads. These maxima are not one guaranteed operating point or an Agentium expectation. [PMLR publication record](https://proceedings.mlr.press/v235/kim24y.html), [LLMCompiler v3, §5](https://arxiv.org/html/2312.04511v3#S5).

The pinned sources are ReAct v3 (2023-03-10), OpenHands v3 (2025-04-18), and LLMCompiler's ICML 2024 publication with arXiv v3 (2024-06-05) as searchable full text. The PMLR-linked published PDF was also read directly for methodology and replanning. Findings concern these papers, not claims about current repository versions of their projects.

## Compare the three execution choices

The following table is engineering judgment, not a result established by these papers.

| Choice | Good fit | Required contract | Main limitation |
| --- | --- | --- | --- |
| Agent loop with tool dependency graphs | Open-ended work where observations determine subsequent operations; known independent tool work within a planning episode | Validate references and inputs; declare effect/resource independence; bound scheduling, replanning, and the parent loop | A tool plan does not define cross-stage completion, shared-state ownership, or recovery |
| Explicit workflow containing bounded Agent loops | Repeatable stages with typed entry/exit requirements and defined branches or joins | Immutable input snapshots, owned output updates, terminal outcomes, deterministic joins, and per-node budgets | Excessive stage decomposition can constrain useful exploration and add orchestration overhead |
| Hybrid | Work with stable stage boundaries and adaptive work inside a stage | Workflow owns transitions and state; Agent owns local reasoning; one scheduler owns each child operation; budgets and evidence cross the boundary | Two levels need clear ownership to avoid duplicate retry, history, or budget logic |

Prefer the hybrid as a compositional contract. Start with workflow nodes that call the existing Agent execution abstraction and return typed results. Add tool dependency scheduling where the workload benefits from it. There is no research requirement that every tool call become a persistent workflow node, or that every task begin with a model-generated graph.

## Proposed boundaries for Agentium

These are design recommendations requiring integration with the actual runtime; they are not observed Agentium behavior.

**A workflow node owns a state transition.** It receives an immutable logical snapshot, produces owned updates and evidence references, and ends with an explicit outcome such as success, failure, cancellation, budget exhaustion, or an unresolved external effect. Edge predicates use a named snapshot and outcome. Simultaneous branches must have disjoint write ownership, a deterministic reducer/stable order, or a surfaced conflict. Join policy must specify whether it requires all branches and how it treats partial failure; completion timing must not select the winner.

**An Agent node owns bounded adaptation.** It may reason, call tools, and revise its local plan within inherited deadline, iteration, tool, and cost limits. Exhaustion is an observable terminal outcome, not a model-generated success message. The parent run remains the authority for cancellation and the overall budget. A nested Agent cannot create a fresh unlimited allowance.

**A tool scheduler owns readiness, not truth.** Missing data-dependency edges are insufficient proof that operations are safe to overlap. Two calls without input/output dependencies may mutate the same file, shell, browser session, account, or external object. Parallel execution should require declared resource/effect compatibility or a conservative allowed set. Validate the full referenced input contract before dispatch. Initially prefer complete validated planning episodes; streamed execution requires an incremental validation and authorization rule before any early effect.

**Replanning changes future work.** Represent each plan with a revision and retain the causal observations used to produce it. A replan may append or supersede pending tasks. Completed results can be reused only when their inputs and relevant environment assumptions remain valid. Superseded/cancelled attempts must not write into the current revision when they finish late. Already-issued effects remain part of history and may require reconciliation; replacing a graph cannot undo them.

**Evidence has provenance and limited authority.** Separate model proposals and summaries from runtime observations and external receipts. A graph edge proves intended dependency, not factual correctness. A tool's successful transport response proves only what that tool contract reports; it may not establish the user's requested outcome. A node claiming completion should refer to the relevant observed checks or receipts. Preserve links among run, graph revision, node attempt, request, observation, and downstream decision. Route/completion logic should use validated outcomes rather than treating narrative confidence as a state mutation.

## Guarantees the research leaves unresolved

The cited architecture/execution descriptions are not a sufficient specification for any of the following. This is a limit of the evidence, not a claim that a current project lacks the capability.

| Concern | Agentium decision still required |
| --- | --- |
| Persistence | Whether the run is intentionally in memory or durable; actual storage, commit boundary, retention, serialization, schema/code compatibility, and crash windows |
| Recovery | Whether restart reuses completed observations or reruns work; how ready/running tasks are restored; how recorded state relates to mutable sandbox/external state |
| Retries | A single retry owner per operation, bounded attempts, and distinctions between transient, permanent, and ambiguous outcomes |
| External effects | Stable logical effect identity tied to inputs, separate from attempt identity; destination idempotency, transactions, receipt reconciliation, compensation, or explicit resolution |
| Cancellation | Propagation to child work, handling of late results, and fencing of stale attempts; cancellation does not prove a remote effect was undone |
| Replay | Recorded model/tool/clock/random outcomes versus new sampling; history inspection, recovery, and deliberate re-execution must have different effect policies |
| Concurrency | Resource access, rate limits, deterministic state merges, duplicate completion handling, branch failures, and scheduling fairness |

In particular, a crash after a remote mutation but before recording its result creates an unknown outcome. A checkpoint or event stream alone cannot make the mutation atomic with local state. Reconcile that uncertainty before an unsafe retry; an outbox alone does not establish once-only remote execution.

Performance expectations for Agentium remain unmeasured. Any speedup depends on the critical path, tool latency, allowed concurrency, planning overhead, model calls, and effect serialization. Evaluate representative work at matched correctness and budget limits before adopting the paper's performance figures as targets.

Useful acceptance scenarios for the integration owner are: a downstream task cannot run before all inputs exist; branch completion order does not change merged output; an invalid dependency fails before dispatch; replanning fences late old results; budget exhaustion terminates nested work; cancellation blocks new downstream dispatch; and a simulated effect/result crash preserves uncertainty without blindly duplicating the effect. Replay checks should supply recorded outcomes and establish that inspection/recovery does not unexpectedly execute tools.
