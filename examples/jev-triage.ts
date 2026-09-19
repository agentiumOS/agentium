/**
 * Jev is a decision model, not a chat model.
 * Questions are per-run — pass a different set on every agent.run().
 *
 *   TYPESAFE_API_KEY=... npx tsx examples/jev-triage.ts
 */

import { Agent, choice, jev, noul, score } from "@agentium/core";

const agent = new Agent({
  name: "ticket-triage",
  model: jev("jev-latest"),
});

const questions = {
  category: choice("What is this support ticket about?", {
    billing: "Charges, invoices, refunds, double billing",
    technical: "Bugs, outages, API errors, login failures",
    other: "Anything else",
  }),
  urgent: noul("Does this need a human response in under 1 hour?"),
  severity: score("How severe is the customer impact?", [
    "none — no real impact",
    "low — inconvenience",
    "medium — work blocked for one person",
    "high — many customers or money at risk",
    "critical — outage or data loss",
  ]),
};

const tickets = [
  "I was charged twice for last month. Please fix this ASAP.",
  "The API returns 500 on /v1/shipments since 9am. No one can create orders.",
  "Where do I change the email on my account?",
];

async function main() {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("Set TYPESAFE_API_KEY first.");
    process.exit(1);
  }

  for (const ticket of tickets) {
    const result = await agent.run(ticket, { questions });
    const answers = JSON.parse(result.text);
    console.log("\n---");
    console.log(ticket);
    console.log(`  category:  ${answers.category?.choice}  (confidence ${answers.category?.confidence})`);
    console.log(`  urgent:    ${answers.urgent?.noul}`);
    console.log(`  severity:  ${answers.severity?.score}  (confidence ${answers.severity?.confidence})`);
    console.log(`  tokens in: ${result.usage.promptTokens}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
