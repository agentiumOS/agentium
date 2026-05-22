#!/usr/bin/env bash
#
# Run all framework benchmarks and generate the comparison report.
#
# Usage:
#   OPENAI_API_KEY=sk-... bash benchmarks/run-all.sh
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

echo "=========================================="
echo "  Agentium Benchmark Suite"
echo "=========================================="
echo ""

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "ERROR: OPENAI_API_KEY is not set."
  exit 1
fi

# 1. Agentium benchmark
echo "[1/3] Running Agentium benchmark..."
npx tsx "$DIR/agentium-bench.ts" > "$DIR/results-agentium.json"
echo "      Done -> results-agentium.json"

# 2. LangChain benchmark
echo "[2/3] Running LangChain benchmark..."
cd "$DIR" && npx tsx "$DIR/langchain-bench.ts" > "$DIR/results-langchain.json"
cd "$ROOT"
echo "      Done -> results-langchain.json"

# 3. Agno benchmark
echo "[3/3] Running Agno benchmark..."
python3 "$DIR/agno-bench.py" > "$DIR/results-agno.json"
echo "      Done -> results-agno.json"

# 4. Generate report
echo ""
echo "Generating report..."
npx tsx "$DIR/report.ts" \
  "$DIR/results-agentium.json" \
  "$DIR/results-langchain.json" \
  "$DIR/results-agno.json"

echo ""
echo "=========================================="
echo "  Benchmark complete! See benchmarks/RESULTS.md"
echo "=========================================="
