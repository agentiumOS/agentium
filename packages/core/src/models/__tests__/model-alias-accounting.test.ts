import { once } from "node:events";
import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixtureContext, fixtureRule } from "../../cost/__tests__/fixtures.js";
import { meteredGenerate, meteredStream } from "../../cost/accounting.js";
import { calculateCharges } from "../../cost/calculator.js";
import { REVIEWED_PRICING_CATALOG } from "../../cost/catalog-data/reviewed.js";
import { withAccountingContext, withAccountingStream } from "../../cost/context.js";
import { CostTracker } from "../../cost/cost-tracker.js";
import { DeepSeekProvider } from "../providers/deepseek.js";
import { normalizeProviderUsage } from "../usage-normalizers.js";

const rawUsage = {
  prompt_tokens: 100,
  completion_tokens: 5,
  total_tokens: 105,
  prompt_cache_hit_tokens: 80,
  prompt_cache_miss_tokens: 20,
};
let baseURL: string;
let requests: unknown[];
const server = createServer(async (req, res) => {
  const buffers: Buffer[] = [];
  for await (const buffer of req) buffers.push(buffer);
  const body = JSON.parse(Buffer.concat(buffers).toString());
  requests.push(body);
  if (body.stream) {
    res.setHeader("content-type", "text/event-stream");
    for (const chunk of [
      {
        id: "served-request",
        model: "deepseek-v4-flash",
        service_tier: "standard",
        choices: [{ delta: { content: "ok" }, finish_reason: null }],
      },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: rawUsage },
    ])
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  } else {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "served-request",
        model: "deepseek-v4-flash",
        service_tier: "standard",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: rawUsage,
      }),
    );
  }
});

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  baseURL = `http://127.0.0.1:${address.port}/v1`;
});
beforeEach(() => {
  requests = [];
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe("DeepSeek served model accounting", () => {
  it.each([false, true])(
    "retains the requested alias and served identity through SDK HTTP (stream=%s)",
    async (stream) => {
      const model = new DeepSeekProvider("deepseek-chat", { apiKey: "fixture-key", baseURL });
      const tracker = new CostTracker();
      const scope = { tracker, tenantId: "alias-test", runId: "rerouted" };
      if (stream) {
        let content = "";
        for await (const chunk of withAccountingStream(scope, () =>
          meteredStream(model, [{ role: "user", content: "hello" }]),
        ))
          if (chunk.type === "text") content += chunk.text;
        expect(content).toBe("ok");
      } else {
        await withAccountingContext(scope, () => meteredGenerate(model, [{ role: "user", content: "hello" }]));
      }
      expect(requests).toHaveLength(1);
      expect(requests[0]).toHaveProperty("model", "deepseek-chat");
      const record = (await tracker.queryUsage({ tenantId: "alias-test", runId: "rerouted" })).items.at(-1);
      expect(record?.context).toMatchObject({
        requestedModelId: "deepseek-chat",
        modelId: "deepseek-v4-flash",
        actualServiceTier: "standard",
        providerRequestId: "served-request",
      });
      expect(record?.usage.rawUsage).toEqual(rawUsage);
      expect(record?.usage.tokens?.input).toMatchObject({ ordinary: 20, cacheRead: 80, cacheWrite: 0 });
      const costs = await tracker.queryCosts({ tenantId: "alias-test", runId: "rerouted" });
      expect(costs.total).toBeNull();
    },
  );

  it("requires an exact explicit tariff for the served model instead of pricing its requested alias", () => {
    const context = {
      ...fixtureContext,
      providerId: "deepseek",
      billingProviderId: "deepseek",
      api: "chat-completions",
      requestedModelId: "deepseek-chat",
      modelId: "deepseek-v4-flash",
      inputTokens: 100,
      contractId: "fixture-contract",
      occurredAt: "2026-10-24T00:00:00.000Z",
    };
    const usage = normalizeProviderUsage("deepseek", "chat-completions", rawUsage, context);
    const unknown = calculateCharges({ context, usage, catalog: REVIEWED_PRICING_CATALOG });
    expect(unknown.total).toBeNull();
    expect(unknown.charges.map((charge) => charge.reason)).toEqual([
      "missing_rate",
      "missing_rate",
      "missing_rate",
      "missing_rate",
    ]);
    const catalog = {
      id: "explicit-fixture-contract",
      version: "1",
      rules: [
        ["token.input", "1"],
        ["token.cache_read", "0.1"],
        ["token.cache_write", "0"],
        ["token.output", "2"],
      ].map(([meter, amount]) =>
        fixtureRule(meter, amount, {
          match: {
            providerId: "deepseek",
            billingProviderId: "deepseek",
            api: "chat-completions",
            modelId: "deepseek-v4-flash",
            contractId: "fixture-contract",
            actualServiceTier: "standard",
            region: "global",
            modality: "*",
            reasoningMode: "*",
            reasoningEffort: "*",
          },
          precedence: "contract",
        }),
      ),
    };
    const assessed = calculateCharges({ context, usage, catalog });
    expect(assessed.total).toBe("0.000038");
    expect(assessed.charges.every((charge) => charge.rule?.match.modelId === "deepseek-v4-flash")).toBe(true);
  });
});
