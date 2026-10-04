import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const exec: typeof run = (async (...args: Parameters<typeof run>) => {
  try {
    return await run(...args);
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`);
  }
}) as typeof run;
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const packages = ["core", "harness", "transport", "queue", "browser", "eval", "observability", "admin", "edge", "cli"];

it.skipIf(process.env.AGENTIUM_TEST_PACKAGES !== "1")(
  "consumes all packed packages and compiles every CLI scaffold without optional SDKs",
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), "agentium-packed-workflows-"));
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    try {
      const dependencies: Record<string, string> = {};
      for (const relative of [
        ...packages.map((p) => `packages/${p}`),
        "node_modules/zod",
        "node_modules/zod-to-json-schema",
        "cli-commander",
        "node_modules/@types/node",
        "node_modules/undici-types",
      ]) {
        const directory =
          relative === "cli-commander"
            ? dirname(createRequire(join(root, "packages/cli/package.json")).resolve("commander"))
            : join(root, relative);
        const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (relative.startsWith("packages/") && !relative.includes("node_modules"))
          await access(join(directory, "dist/index.js"));
        const packed = await exec(
          npm,
          [
            "pack",
            directory,
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            fixture,
            "--cache",
            join(fixture, "cache"),
          ],
          { cwd: fixture, timeout: 30_000, env: { ...process.env, HUSKY: "0" } },
        );
        dependencies[metadata.name] =
          `file:${join(fixture, JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[")))[0].filename)}`;
      }
      await writeFile(
        join(fixture, "package.json"),
        JSON.stringify({ name: "agentium-consumer-fixture", private: true, type: "module", dependencies }),
      );
      await exec(
        npm,
        [
          "install",
          "--offline",
          "--cache",
          join(fixture, "cache"),
          "--ignore-scripts",
          "--legacy-peer-deps",
          "--omit=optional",
          "--no-audit",
          "--no-fund",
        ],
        { cwd: fixture, timeout: 60_000 },
      );
      for (const name of [
        "openai",
        "@anthropic-ai/sdk",
        "@google/genai",
        "bullmq",
        "ioredis",
        "playwright",
        "socket.io",
        "express",
        "@e2b/code-interpreter",
        "@daytona/sdk",
        "@opentelemetry/api",
      ])
        await expect(access(join(fixture, "node_modules", name))).rejects.toThrow();
      const exports = {
        core: "Agent",
        harness: "HarnessRuntime",
        transport: "createAgentGateway",
        queue: "AgentQueue",
        browser: "BrowserAgent",
        eval: "EvalSuite",
        observability: "Tracer",
        admin: "createAdminRouter",
        edge: "EdgeRuntime",
        cli: "newProject",
      };
      for (const mode of ["esm", "cjs"]) {
        const statements = Object.entries(exports).map(
          ([pkg, exported], index) =>
            `${mode === "esm" ? `import * as p${index} from "@agentium/${pkg}"` : `const p${index} = require("@agentium/${pkg}")`}; if (typeof p${index}.${exported} !== "function") throw new Error("Missing ${pkg}.${exported}");`,
        );
        const path = join(fixture, mode === "esm" ? "imports.mjs" : "imports.cjs");
        await writeFile(path, statements.join("\n"));
        await exec(process.execPath, [path], { cwd: fixture });
      }
      // Every declared entry, including wildcard toolkits, must load in isolation.
      const allEntries = join(fixture, "all-entries.mjs");
      await writeFile(
        allEntries,
        `
        import { readFileSync, readdirSync } from 'node:fs';
        import { join, dirname, basename } from 'node:path';
        import { pathToFileURL } from 'node:url';
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        for (const name of ${JSON.stringify(packages)}) {
          const root = join(process.cwd(), 'node_modules/@agentium', name);
          const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
          const entries = new Set();
          const collect = value => {
            if (typeof value === 'string' && /\\.(js|cjs)$/.test(value)) entries.add(value);
            else if (value && typeof value === 'object') Object.values(value).forEach(collect);
          };
          collect(metadata.exports);
          for (const pattern of entries) {
            const suffix = pattern.endsWith('.cjs') ? '.cjs' : '.js';
            const paths = pattern.includes('*')
              ? readdirSync(join(root, dirname(pattern))).filter(file => file.endsWith(suffix)).map(file => join(root, dirname(pattern), file))
              : [join(root, pattern)];
            for (const path of paths) {
              const loaded = path.endsWith('.cjs') ? require(path) : await import(pathToFileURL(path));
              if (!Object.keys(loaded).length) throw new Error('Empty entry: ' + basename(path));
            }
          }
        }
      `,
      );
      await exec(process.execPath, [allEntries], { cwd: fixture });
      const bin = join(fixture, "node_modules/@agentium/cli/dist/bin.js");
      expect((await readFile(bin, "utf8")).startsWith("#!/usr/bin/env node")).toBe(true);
      expect((await exec(process.execPath, [bin, "--version"], { cwd: fixture })).stdout.trim()).toBe(
        JSON.parse(await readFile(join(root, "packages/cli/package.json"), "utf8")).version,
      );
      for (const template of ["basic", "rag", "voice", "browser"]) {
        await exec(process.execPath, [bin, "init", template, "--template", template], { cwd: fixture });
        await exec(
          process.execPath,
          [
            join(root, "node_modules/typescript/bin/tsc"),
            "-p",
            join(fixture, template, "tsconfig.json"),
            "--noEmit",
            "--pretty",
            "false",
          ],
          { cwd: fixture },
        );
      }
      const ordinary = `import { Agent, InMemoryStorage, SessionManager, defineTool, openai, anthropic, google } from "@agentium/core";
import { z } from "zod";
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
let calls = 0;
const model = { providerId: "fixture", modelId: "fixture", async generate() {
  calls++;
  return { message: calls === 1 ? { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "tool-value" } }] } : { role: "assistant", content: "done" }, finishReason: calls === 1 ? "tool_calls" : "stop", usage, raw: {} };
}, async *stream() { yield { type: "text", text: "streamed" }; yield { type: "finish", finishReason: "stop", usage }; } };
let effects = 0;
const tool = defineTool({ name: "echo", description: "Echo input", parameters: z.object({ text: z.string() }), execute: async ({ text }) => { effects++; return text; } });
const storage = new InMemoryStorage();
const sessions = new SessionManager(storage);
await sessions.getOrCreate("manual"); await sessions.appendMessage("manual", { role: "user", content: "history" });
if ((await sessions.getHistory("manual")).length !== 1) throw new Error("SessionManager contract");
for (const factory of [openai, anthropic, google]) if (typeof factory !== "function") throw new Error("Provider export");
const agent = new Agent({ name: "consumer", model, tools: [tool], register: false, memory: { storage } });
try {
 const result = await agent.run("hello", { sessionId: "reuse" });
 if (result.text !== "done" || effects !== 1 || result.toolCalls.length !== 1) throw new Error("Agent/tool contract");
 await agent.run("again", { sessionId: "reuse" });
 let text = ""; for await (const chunk of agent.stream("stream", { sessionId: "reuse" })) if (chunk.type === "text") text += chunk.text;
 if (text !== "streamed") throw new Error("Streaming contract");
} finally { await agent.close(); }
`;
      await writeFile(join(fixture, "ordinary.mjs"), ordinary);
      await exec(process.execPath, [join(fixture, "ordinary.mjs")], { cwd: fixture, timeout: 20_000 });
      const types = `import { Agent, defineTool, SessionManager, InMemoryStorage, type ModelProvider } from "@agentium/core";
import { z } from "zod";
import { EvalSuite } from "@agentium/eval";
import { Tracer } from "@agentium/observability";
import { createAgentGateway, type GatewayOptions } from "@agentium/transport";
import { newProject } from "@agentium/cli";
import { AgentQueue } from "@agentium/queue";
import { createAdminRouter } from "@agentium/admin";
import { EdgeRuntime } from "@agentium/edge";
import { BrowserAgent } from "@agentium/browser";
import { defineHarness, HarnessRuntime } from "@agentium/harness";
void AgentQueue; void createAdminRouter; void EdgeRuntime; void BrowserAgent; void HarnessRuntime; defineHarness({ abilities: [] });
declare const model: ModelProvider;
const tool = defineTool({name:"echo",description:"Echo",parameters:z.object({text:z.string()}),execute:async ({text})=>text});
const agent = new Agent({name:"consumer",model,tools:[tool],workspace:{path:".",mode:"read"}});
new SessionManager(new InMemoryStorage());
new EvalSuite({name:"consumer",agent,cases:[],scorers:[{name:"check",score:async()=>({score:1,pass:true})}]});
const security: GatewayOptions["security"] = {mode:"local"};
void security; void Tracer; void createAgentGateway; void newProject;
// @ts-expect-error selected breaking removal
Agent.deep({name:"consumer",model});
// @ts-expect-error direct harness composition removed
new Agent({name:"consumer",model,harness:{}});
`;
      await writeFile(join(fixture, "consumer.ts"), types);
      await writeFile(join(fixture, "consumer.cts"), types);
      await writeFile(
        join(fixture, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            skipLibCheck: true,
            types: ["node"],
          },
          files: ["consumer.ts", "consumer.cts"],
        }),
      );
      await exec(
        process.execPath,
        [join(root, "node_modules/typescript/bin/tsc"), "-p", join(fixture, "tsconfig.json"), "--pretty", "false"],
        { cwd: fixture },
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
  180_000,
);
