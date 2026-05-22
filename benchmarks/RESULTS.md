# Agentium vs LangChain vs Agno -- Performance & Cost Comparison

> Model: `gpt-4o-mini` | Runs per scenario: 5 | 2026-03-02

---

### Scenario 1: Simple Completion

| Metric | Agentium | LangChain | Agno |
|--------|-------|-------|-------|
| Startup (ms) | 272 **best** | 321 | 3386 |
| Avg Response (ms) | 954 | 865 **best** | 2980 |
| Avg Prompt Tokens | 28 **best** | 28 **best** | 28 **best** |
| Avg Completion Tokens | 7 **best** | 7 **best** | 7 **best** |
| Avg Total Tokens | 35 **best** | 35 **best** | 35 **best** |
| Avg Cost / Run | $0.000008 **best** | $0.000008 **best** | $0.000008 **best** |
| Memory Delta (MB) | -12.77 | -16.4 **best** | 10.46 |

---

### Scenario 2: Tool Calling

| Metric | Agentium | LangChain | Agno |
|--------|-------|-------|-------|
| Startup (ms) | 37 | 128 | 0 **best** |
| Avg Response (ms) | 1927 | 1848 **best** | 4616 |
| Avg Prompt Tokens | 167 **best** | 167 **best** | 173 |
| Avg Completion Tokens | 29 **best** | 29 **best** | 29 **best** |
| Avg Total Tokens | 196 **best** | 196 **best** | 202 |
| Avg Cost / Run | $0.000042 **best** | $0.000042 **best** | $0.000043 |
| Memory Delta (MB) | -75.89 **best** | -69.44 | 1.29 |

---

### Scenario 3: Multi-turn Memory

| Metric | Agentium | LangChain | Agno |
|--------|-------|-------|-------|
| Startup (ms) | 3 | 14 | 0 **best** |
| Avg Response (ms) | 2396 **best** | 2428 | 7895 |
| Avg Prompt Tokens | 183 | 314 | 94 **best** |
| Avg Completion Tokens | 26 **best** | 62 | 69 |
| Avg Total Tokens | 209 | 377 | 163 **best** |
| Avg Cost / Run | $0.000043 **best** | $0.000084 | $0.000056 |
| Memory Delta (MB) | -5.28 | -18.23 **best** | 0.22 |

---

### Scenario 4: Prompt Caching

| Metric | Agentium | LangChain | Agno |
|--------|-------|-------|-------|
| Startup (ms) | 1 | 3 | 0 **best** |
| Avg Response (ms) | 7558 **best** | 8352 | 9544 |
| Avg Prompt Tokens | 37 **best** | 37 **best** | 37 **best** |
| Avg Completion Tokens | 431 **best** | 451 | 463 |
| Avg Total Tokens | 468 **best** | 488 | 500 |
| Avg Cost / Run | $0.000264 **best** | $0.000276 | $0.000283 |
| Memory Delta (MB) | -9.82 | -16.58 **best** | 0.18 |

---

### Scenario 5: Cost Tracking

| Metric | Agentium | LangChain | Agno |
|--------|-------|-------|-------|
| Avg Response (ms) | 2107 | 2038 | 3277 |
| Avg Total Tokens | 108 | 108 | 104 |
| | | | |
| **Cost Breakdown** | | | |
| Total Cost | $0.00005331 | $0.00005355 | $0.00005103 |
| Input Cost | $0.00000375 | $0.00000375 | $0.00000375 |
| Output Cost | $0.00004956 | $0.00004980 | $0.00004728 |
| Reasoning Cost | N/A | N/A | N/A |
| Cached Cost | N/A | N/A | N/A |
| Audio Input Cost | N/A | N/A | N/A |
| Audio Output Cost | N/A | N/A | N/A |

---

## Token Type Breakdown Comparison

Shows which token types each framework actually extracts from the API.


### Simple Completion — Token Details (Run 1)

| Token Type | Agentium | LangChain | Agno |
|------------|-------|-------|-------|
| Input Tokens | 28 | 28 | 28 |
| Output Tokens | 7 | 7 | 7 |
| Total Tokens | 35 | 35 | 35 |
| Reasoning Tokens | 0 | 0 | 0 |
| Cached Tokens (read) | 0 | 0 | 0 |
| Cache Write Tokens | 0 | 0 | 0 |
| Audio Input Tokens | 0 | 0 | 0 |
| Audio Output Tokens | 0 | 0 | 0 |

### Tool Calling — Token Details (Run 1)

| Token Type | Agentium | LangChain | Agno |
|------------|-------|-------|-------|
| Input Tokens | 167 | 167 | 173 |
| Output Tokens | 29 | 29 | 29 |
| Total Tokens | 196 | 196 | 202 |
| Reasoning Tokens | 0 | 0 | 0 |
| Cached Tokens (read) | 0 | 0 | 0 |
| Cache Write Tokens | 0 | 0 | 0 |
| Audio Input Tokens | 0 | 0 | 0 |
| Audio Output Tokens | 0 | 0 | 0 |

### Multi-turn Memory — Token Details (Run 1)

| Token Type | Agentium | LangChain | Agno |
|------------|-------|-------|-------|
| Input Tokens | 184 | 309 | 94 |
| Output Tokens | 27 | 57 | 71 |
| Total Tokens | 211 | 366 | 165 |
| Reasoning Tokens | 0 | 0 | 0 |
| Cached Tokens (read) | 0 | 0 | 0 |
| Cache Write Tokens | 0 | 0 | 0 |
| Audio Input Tokens | 0 | 0 | 0 |
| Audio Output Tokens | 0 | 0 | 0 |

### Prompt Caching — Token Details (Run 1)

| Token Type | Agentium | LangChain | Agno |
|------------|-------|-------|-------|
| Input Tokens | 37 | 37 | 37 |
| Output Tokens | 411 | 504 | 488 |
| Total Tokens | 448 | 541 | 525 |
| Reasoning Tokens | 0 | 0 | 0 |
| Cached Tokens (read) | 0 | 0 | 0 |
| Cache Write Tokens | 0 | 0 | 0 |
| Audio Input Tokens | 0 | 0 | 0 |
| Audio Output Tokens | 0 | 0 | 0 |

### Cost Tracking — Token Details (Run 1)

| Token Type | Agentium | LangChain | Agno |
|------------|-------|-------|-------|
| Input Tokens | 25 | 25 | 25 |
| Output Tokens | 84 | 84 | 86 |
| Total Tokens | 109 | 109 | 111 |
| Reasoning Tokens | 0 | 0 | 0 |
| Cached Tokens (read) | 0 | 0 | 0 |
| Cache Write Tokens | 0 | 0 | 0 |
| Audio Input Tokens | 0 | 0 | 0 |
| Audio Output Tokens | 0 | 0 | 0 |

---

## Token Accuracy: CostTracker vs API

Verifies that Agentium `CostTracker` records **exactly** the same token counts the API returns.

| Scenario | Runs | Matches | Accuracy | Status |
|----------|------|---------|----------|--------|
| Simple Completion | 5 | 5/5 | 100% | PASS |
| Tool Calling | 5 | 5/5 | 100% | PASS |
| Multi Turn Memory | 5 | 5/5 | 100% | PASS |
| Prompt Caching | 5 | 5/5 | 100% | PASS |
| Cost Tracking | 5 | 5/5 | 100% | PASS |
| **Overall** | **25** | **25/25** | **100%** | **PASS** |

### Per-Run Detail (Simple Completion)

| Run | Source | Input | Output | Total | Reasoning | Cached | Audio In | Audio Out | Match |
|-----|--------|-------|--------|-------|-----------|--------|----------|-----------|-------|
| 1 | API | 28 | 7 | 35 | 0 | 0 | 0 | 0 | |
| | Tracker | 28 | 7 | 35 | 0 | 0 | 0 | 0 | MATCH |
| 2 | API | 28 | 7 | 35 | 0 | 0 | 0 | 0 | |
| | Tracker | 28 | 7 | 35 | 0 | 0 | 0 | 0 | MATCH |
| 3 | API | 28 | 7 | 35 | 0 | 0 | 0 | 0 | |
| | Tracker | 28 | 7 | 35 | 0 | 0 | 0 | 0 | MATCH |
| 4 | API | 28 | 7 | 35 | 0 | 0 | 0 | 0 | |
| | Tracker | 28 | 7 | 35 | 0 | 0 | 0 | 0 | MATCH |
| 5 | API | 28 | 7 | 35 | 0 | 0 | 0 | 0 | |
| | Tracker | 28 | 7 | 35 | 0 | 0 | 0 | 0 | MATCH |

### Per-Run Detail (Multi Turn Memory)

| Run | Source | Input | Output | Total | Reasoning | Cached | Audio In | Audio Out | Match |
|-----|--------|-------|--------|-------|-----------|--------|----------|-----------|-------|
| 1 | API | 184 | 27 | 211 | 0 | 0 | 0 | 0 | |
| | Tracker | 184 | 27 | 211 | 0 | 0 | 0 | 0 | MATCH |
| 2 | API | 178 | 24 | 202 | 0 | 0 | 0 | 0 | |
| | Tracker | 178 | 24 | 202 | 0 | 0 | 0 | 0 | MATCH |
| 3 | API | 196 | 33 | 229 | 0 | 0 | 0 | 0 | |
| | Tracker | 196 | 33 | 229 | 0 | 0 | 0 | 0 | MATCH |
| 4 | API | 178 | 24 | 202 | 0 | 0 | 0 | 0 | |
| | Tracker | 178 | 24 | 202 | 0 | 0 | 0 | 0 | MATCH |
| 5 | API | 178 | 24 | 202 | 0 | 0 | 0 | 0 | |
| | Tracker | 178 | 24 | 202 | 0 | 0 | 0 | 0 | MATCH |

### Per-Run Detail (Prompt Caching)

| Run | Source | Input | Output | Total | Reasoning | Cached | Audio In | Audio Out | Match |
|-----|--------|-------|--------|-------|-----------|--------|----------|-----------|-------|
| 1 | API | 37 | 411 | 448 | 0 | 0 | 0 | 0 | |
| | Tracker | 37 | 411 | 448 | 0 | 0 | 0 | 0 | MATCH |
| 2 | API | 37 | 429 | 466 | 0 | 0 | 0 | 0 | |
| | Tracker | 37 | 429 | 466 | 0 | 0 | 0 | 0 | MATCH |
| 3 | API | 37 | 424 | 461 | 0 | 0 | 0 | 0 | |
| | Tracker | 37 | 424 | 461 | 0 | 0 | 0 | 0 | MATCH |
| 4 | API | 37 | 417 | 454 | 0 | 0 | 0 | 0 | |
| | Tracker | 37 | 417 | 454 | 0 | 0 | 0 | 0 | MATCH |
| 5 | API | 37 | 475 | 512 | 0 | 0 | 0 | 0 | |
| | Tracker | 37 | 475 | 512 | 0 | 0 | 0 | 0 | MATCH |

---

## Cost Tracking Feature Comparison

| Feature | Agentium | LangChain | Agno |
|---------|-------|-------|-------|

> **Note:** LangChain Python has `get_openai_callback()` with built-in pricing; LangChain JS requires manual callbacks.
> Agno tracks all token types but has no cost calculator. LangSmith (paid SaaS) adds full cost tracking to LangChain.

| **Token Tracking** |  |  |  |
| Input / Output Tokens | Yes | Yes | Yes |
| Reasoning Tokens | Yes | Yes (Python only) | Yes |
| Cached Tokens (read) | Yes | Yes (Python only) | Yes |
| Cache Write Tokens | No (OpenAI N/A) | No | Yes |
| Audio Input Tokens | Yes | No (LangSmith: Yes) | Yes |
| Audio Output Tokens | Yes | No (LangSmith: Yes) | Yes |
| Per-Session Aggregation | Yes | Via LangSmith | Yes |
| **Cost Calculation** |  |  |  |
| Built-in Cost Calculator | Yes (auto) | Python only | No |
| JS/TS Cost Calculation | Yes (native) | No (manual) | N/A (Python) |
| Multi-Provider Pricing Table | Yes (50+ models) | OpenAI only | No |
| Per-Category Cost Breakdown | Yes (6 categories) | Via LangSmith | No |
| **Budget & Aggregation** |  |  |  |
| Cost Budget / Limits | Yes (run/session/user) | No | No |
| Mid-Run Budget Enforcement | Yes (auto-stop) | No | No |
| By-Agent Aggregation | Yes | Via LangSmith | No |
| By-Model Aggregation | Yes | Via LangSmith | No |
| By-User Aggregation | Yes | No | No |
| Token Accuracy Validation | 100% verified | Not tested | Not tested |
| Requires External Service | No | LangSmith ($$$) | No |

---

## Summary

| Scenario | Fastest | Fewest Tokens | Cheapest |
|----------|---------|---------------|----------|
| Simple Completion | LangChain (865ms) | Agentium (35) | Agentium ($0.00000840) |
| Tool Calling | LangChain (1848ms) | Agentium (196) | LangChain ($0.000042) |
| Multi-turn Memory | Agentium (2396ms) | Agno (163) | Agentium ($0.00004326) |
| Prompt Caching | Agentium (7558ms) | Agentium (468) | Agentium ($0.00026427) |
| Cost Tracking | LangChain (2038ms) | Agno (104) | Agno ($0.00005103) |

---

## Methodology

- All benchmarks use the same model (`gpt-4o-mini`) and identical prompts.
- Each scenario is run 5 times; results are averaged.
- Startup time measures framework import + agent initialization (before first LLM call).
- Memory delta measures RSS growth (Node.js) or traced allocation (Python) during the scenario runs.
- Token counts reflect framework overhead (system prompts, tool schemas, history injection).
- Network latency to OpenAI API is shared across all frameworks and not isolated.
- Agentium and LangChain run on Node.js; Agno runs on Python. Cross-language memory comparisons should be interpreted with that in mind.
- Cost calculated using gpt-4o-mini pricing: $0.15/1M input tokens, $0.6/1M output tokens.
- Agentium cost tracking is built-in via `CostTracker` — token accuracy verified against raw API responses.
- LangChain JS and Agno costs are manually calculated; LangChain Python has `get_openai_callback()` for OpenAI only.
- Prompt caching scenario repeats the same prompt 5 times to trigger OpenAI's automatic prompt caching.
- Token details (reasoning, cached, audio) are extracted from each framework's API response metadata to verify actual availability.
