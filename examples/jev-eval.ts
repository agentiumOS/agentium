/**
 * Jev as an eval judge — the agent under test writes the reply, Jev scores it.
 *
 * Canned replies so you only need TYPESAFE_API_KEY.
 * Swap cannedSupport() for openai("gpt-4o-mini") to judge a real agent.
 *
 *   TYPESAFE_API_KEY=... npx tsx examples/jev-eval.ts
 */

import { Agent, jev, noul, score, type ModelProvider } from "@agentium/core";
import { EvalSuite, custom, ConsoleReporter } from "@agentium/eval";

const replies: Record<string, string> = {
  // Stay on the ticket. Do not invent a refund — Jev treats that as unfaithful.
  "I was charged twice for last month.":
    "You reported a double charge for last month. I can look that up and help with billing.",
  "The API returns 500 on /v1/shipments.":
    "We never had an outage. I checked a system that does not exist. Try turning it off.",
  "What's the weather in Paris?":
    "Paris is usually mild in spring. I can also look up your last invoice if you want.",
};

function cannedSupport(): ModelProvider {
  return {
    providerId: "canned",
    modelId: "canned",
    async generate(messages) {
      const last = [...messages].reverse().find((m) => m.role === "user");
      const text = typeof last?.content === "string" ? last.content : "";
      const content = replies[text] ?? "I'll look into this and get back to you.";
      return {
        message: { role: "assistant", content },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop",
        raw: {},
      };
    },
    async *stream() {},
  };
}

const agent = new Agent({
  name: "support",
  model: cannedSupport(),
  instructions: "Help the customer. Stay on the ticket. Do not invent facts.",
});

const judge = new Agent({
  name: "jev-judge",
  model: jev("jev-latest"),
});

const suite = new EvalSuite({
  name: "support quality (Jev judge)",
  agent,
  cases: [
    { name: "double-charge", input: "I was charged twice for last month." },
    { name: "made-up-outage", input: "The API returns 500 on /v1/shipments." },
    { name: "off-topic", input: "What's the weather in Paris?" },
  ],
  scorers: [
    custom("faithful", async (input, output) => {
      const result = await judge.run(JSON.stringify({ ticket: input, reply: output.text }), {
        questions: {
          faithful: noul(
            "Does the reply stay true to the ticket — no fake systems, no weather, no denying what the customer said?",
          ),
          onTopic: noul("Is the reply about the customer's request, not a side topic?"),
          helpful: score("How useful is this reply for the customer?", [
            "unhelpful",
            "partial",
            "useful",
            "excellent",
          ]),
        },
      });
      const a = JSON.parse(result.text);
      const s = a.faithful.noul as number;
      return {
        score: s,
        pass: s >= 0.7 && a.onTopic.noul >= 0.7,
        reason: `faithful=${s} onTopic=${a.onTopic.noul} helpful=${a.helpful.score}`,
      };
    }),
  ],
  threshold: 0.7,
});

async function main() {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("Set TYPESAFE_API_KEY first.");
    process.exit(1);
  }

  const result = await suite.run([new ConsoleReporter()]);
  const byName = Object.fromEntries(result.results.map((r) => [r.caseName, r.pass]));
  const expected =
    byName["double-charge"] === true && byName["made-up-outage"] === false && byName["off-topic"] === false;
  console.log(`\n${result.passed}/${result.total} passed (avg ${result.averageScore.toFixed(2)})`);
  console.log(expected ? "Expected pattern: 1 pass (grounded billing), 2 fails." : "Unexpected pass/fail pattern.");
  process.exit(expected ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
