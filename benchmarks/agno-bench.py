"""
Agno Performance Benchmark

Measures startup time, response latency, token usage (all types), memory,
and cost tracking across 5 scenarios.

Extracts ALL available token types from Agno's metrics to see what it
actually exposes: input, output, reasoning, cache_read, cache_write,
audio_input, audio_output.

Outputs JSON to stdout for the report generator.

Usage:
    OPENAI_API_KEY=sk-... python benchmarks/agno-bench.py
"""

import json
import time
import tracemalloc
import os
import logging
import sys

logging.disable(logging.CRITICAL)

# Load .env manually
try:
    with open(os.path.join(os.path.dirname(__file__), "..", ".env")) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"')
                if key and key not in os.environ:
                    os.environ[key] = value
except FileNotFoundError:
    pass

RUNS = 5
MODEL = "gpt-4o-mini"
PROMPT_SIMPLE = "What is the capital of France? Answer in one sentence."
PROMPT_TOOL = "What is the weather in San Francisco?"
PROMPTS_MULTI = [
    "My name is Alice and I live in Berlin.",
    "What city do I live in?",
    "What is my name?",
]
PROMPT_COST = "Explain quantum computing in exactly 3 sentences."
PROMPT_CACHE = "List all planets in our solar system with one fact about each."

INPUT_PER_1K = 0.00015
OUTPUT_PER_1K = 0.0006


def get_mem_mb():
    current, _ = tracemalloc.get_traced_memory()
    return round(current / 1024 / 1024, 2)


def extract_all_token_details(response):
    """Extract ALL token types from Agno response metrics."""
    metrics = getattr(response, "metrics", None)

    input_tokens = getattr(metrics, "input_tokens", 0) or 0
    output_tokens = getattr(metrics, "output_tokens", 0) or 0
    reasoning_tokens = getattr(metrics, "reasoning_tokens", 0) or 0
    cache_read_tokens = getattr(metrics, "cache_read_tokens", 0) or 0
    cache_write_tokens = getattr(metrics, "cache_write_tokens", 0) or 0
    audio_input_tokens = getattr(metrics, "audio_input_tokens", 0) or 0
    audio_output_tokens = getattr(metrics, "audio_output_tokens", 0) or 0

    # If top-level is empty, accumulate from messages
    if input_tokens == 0 and output_tokens == 0:
        for msg in getattr(response, "messages", []) or []:
            m = getattr(msg, "metrics", None)
            if m:
                input_tokens += getattr(m, "input_tokens", 0) or 0
                output_tokens += getattr(m, "output_tokens", 0) or 0
                reasoning_tokens += getattr(m, "reasoning_tokens", 0) or 0
                cache_read_tokens += getattr(m, "cache_read_tokens", 0) or 0
                cache_write_tokens += getattr(m, "cache_write_tokens", 0) or 0
                audio_input_tokens += getattr(m, "audio_input_tokens", 0) or 0
                audio_output_tokens += getattr(m, "audio_output_tokens", 0) or 0

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "reasoning_tokens": reasoning_tokens,
        "cached_tokens": cache_read_tokens,
        "cache_write_tokens": cache_write_tokens,
        "audio_input_tokens": audio_input_tokens,
        "audio_output_tokens": audio_output_tokens,
    }


def add_details(a, b):
    return {
        "input_tokens": a["input_tokens"] + b["input_tokens"],
        "output_tokens": a["output_tokens"] + b["output_tokens"],
        "total_tokens": a["total_tokens"] + b["total_tokens"],
        "reasoning_tokens": a["reasoning_tokens"] + b["reasoning_tokens"],
        "cached_tokens": a["cached_tokens"] + b["cached_tokens"],
        "cache_write_tokens": a["cache_write_tokens"] + b["cache_write_tokens"],
        "audio_input_tokens": a["audio_input_tokens"] + b["audio_input_tokens"],
        "audio_output_tokens": a["audio_output_tokens"] + b["audio_output_tokens"],
    }


def empty_details():
    return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "reasoning_tokens": 0, "cached_tokens": 0, "cache_write_tokens": 0, "audio_input_tokens": 0, "audio_output_tokens": 0}


# ---------- Scenario 1: Simple Completion ----------

def scenario1():
    tracemalloc.start()
    t0 = time.perf_counter()

    from agno.agent import Agent
    from agno.models.openai import OpenAIChat

    agent = Agent(model=OpenAIChat(id=MODEL), instructions=["Answer concisely."])
    startup_ms = round((time.perf_counter() - t0) * 1000)
    mem_before = get_mem_mb()

    runs = []
    for _ in range(RUNS):
        t1 = time.perf_counter()
        response = agent.run(PROMPT_SIMPLE)
        response_ms = round((time.perf_counter() - t1) * 1000)
        details = extract_all_token_details(response)
        runs.append({
            "responseMs": response_ms,
            "promptTokens": details["input_tokens"],
            "completionTokens": details["output_tokens"],
            "totalTokens": details["total_tokens"],
            "tokenDetails": details,
        })

    mem_after = get_mem_mb()
    tracemalloc.stop()
    return {"name": "simple_completion", "startupMs": startup_ms, "memoryMB": round(mem_after - mem_before, 2), "runs": runs}


# ---------- Scenario 2: Tool Calling ----------

def scenario2():
    tracemalloc.start()
    t0 = time.perf_counter()

    from agno.agent import Agent
    from agno.models.openai import OpenAIChat

    def get_weather(location: str) -> str:
        """Get the current weather for a location.

        Args:
            location (str): City name
        """
        return f"Weather in {location}: 60°F, foggy."

    agent = Agent(model=OpenAIChat(id=MODEL), instructions=["Use tools to answer questions. Be concise."], tools=[get_weather])
    startup_ms = round((time.perf_counter() - t0) * 1000)
    mem_before = get_mem_mb()

    runs = []
    for _ in range(RUNS):
        t1 = time.perf_counter()
        response = agent.run(PROMPT_TOOL)
        response_ms = round((time.perf_counter() - t1) * 1000)
        details = extract_all_token_details(response)
        runs.append({
            "responseMs": response_ms,
            "promptTokens": details["input_tokens"],
            "completionTokens": details["output_tokens"],
            "totalTokens": details["total_tokens"],
            "tokenDetails": details,
        })

    mem_after = get_mem_mb()
    tracemalloc.stop()
    return {"name": "tool_calling", "startupMs": startup_ms, "memoryMB": round(mem_after - mem_before, 2), "runs": runs}


# ---------- Scenario 3: Multi-turn Memory ----------

def scenario3():
    tracemalloc.start()
    t0 = time.perf_counter()

    from agno.agent import Agent
    from agno.models.openai import OpenAIChat

    agent = Agent(
        model=OpenAIChat(id=MODEL),
        instructions=["You are a helpful assistant. Remember what the user tells you."],
        add_history_to_context=True,
        num_history_runs=10,
    )
    startup_ms = round((time.perf_counter() - t0) * 1000)
    mem_before = get_mem_mb()

    runs = []
    for i in range(RUNS):
        session_id = f"bench-session-{i}"
        accumulated = empty_details()
        t1 = time.perf_counter()

        for prompt in PROMPTS_MULTI:
            response = agent.run(prompt, session_id=session_id)
            details = extract_all_token_details(response)
            accumulated = add_details(accumulated, details)

        response_ms = round((time.perf_counter() - t1) * 1000)
        runs.append({
            "responseMs": response_ms,
            "promptTokens": accumulated["input_tokens"],
            "completionTokens": accumulated["output_tokens"],
            "totalTokens": accumulated["total_tokens"],
            "tokenDetails": accumulated,
        })

    mem_after = get_mem_mb()
    tracemalloc.stop()
    return {"name": "multi_turn_memory", "startupMs": startup_ms, "memoryMB": round(mem_after - mem_before, 2), "runs": runs}


# ---------- Scenario 4: Prompt Caching ----------

def scenario4():
    tracemalloc.start()
    t0 = time.perf_counter()

    from agno.agent import Agent
    from agno.models.openai import OpenAIChat

    agent = Agent(
        model=OpenAIChat(id=MODEL),
        instructions=["You are a precise astronomy assistant. Always answer in full detail."],
    )
    startup_ms = round((time.perf_counter() - t0) * 1000)
    mem_before = get_mem_mb()

    runs = []
    for _ in range(RUNS):
        t1 = time.perf_counter()
        response = agent.run(PROMPT_CACHE)
        response_ms = round((time.perf_counter() - t1) * 1000)
        details = extract_all_token_details(response)
        runs.append({
            "responseMs": response_ms,
            "promptTokens": details["input_tokens"],
            "completionTokens": details["output_tokens"],
            "totalTokens": details["total_tokens"],
            "tokenDetails": details,
        })

    mem_after = get_mem_mb()
    tracemalloc.stop()
    return {"name": "prompt_caching", "startupMs": startup_ms, "memoryMB": round(mem_after - mem_before, 2), "runs": runs}


# ---------- Scenario 5: Cost Tracking ----------

def scenario5():
    tracemalloc.start()
    t0 = time.perf_counter()

    from agno.agent import Agent
    from agno.models.openai import OpenAIChat

    agent = Agent(model=OpenAIChat(id=MODEL), instructions=["Answer precisely as instructed."])
    startup_ms = round((time.perf_counter() - t0) * 1000)
    mem_before = get_mem_mb()

    runs = []
    for _ in range(RUNS):
        t1 = time.perf_counter()
        response = agent.run(PROMPT_COST)
        response_ms = round((time.perf_counter() - t1) * 1000)
        details = extract_all_token_details(response)

        cost_input = (details["input_tokens"] / 1000) * INPUT_PER_1K
        cost_output = (details["output_tokens"] / 1000) * OUTPUT_PER_1K

        runs.append({
            "responseMs": response_ms,
            "promptTokens": details["input_tokens"],
            "completionTokens": details["output_tokens"],
            "totalTokens": details["total_tokens"],
            "tokenDetails": details,
            "costTotal": cost_input + cost_output,
            "costInput": cost_input,
            "costOutput": cost_output,
            "costReasoning": 0,
            "costCached": 0,
            "costAudioInput": 0,
            "costAudioOutput": 0,
        })

    mem_after = get_mem_mb()
    tracemalloc.stop()
    return {"name": "cost_tracking", "startupMs": startup_ms, "memoryMB": round(mem_after - mem_before, 2), "runs": runs}


# ---------- Main ----------

if __name__ == "__main__":
    results = {
        "framework": "Agno",
        "model": MODEL,
        "scenarios": [scenario1(), scenario2(), scenario3(), scenario4(), scenario5()],
    }
    print(json.dumps(results, indent=2))
