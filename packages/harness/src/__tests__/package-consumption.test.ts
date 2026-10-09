import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const enabled = process.env.AGENTIUM_TEST_PACKAGES === "1";

// Explicit post-build gate: ordinary source tests must not accidentally validate stale dist artifacts.
it.skipIf(!enabled)(
  "consumes packed core+harness via ESM, CommonJS and public TypeScript without optional SDKs",
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), "agentium-packed-harness-"));
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    try {
      const dependencies: Record<string, string> = {};
      for (const relative of [
        "packages/core",
        "packages/harness",
        "node_modules/zod",
        "node_modules/zod-v3",
        "node_modules/zod-to-json-schema",
      ]) {
        const directory =
          relative === "packages/harness" && process.env.AGENTIUM_HARNESS_PACKAGE_DIR
            ? process.env.AGENTIUM_HARNESS_PACKAGE_DIR
            : join(root, relative);
        const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (relative.startsWith("packages/")) await access(join(directory, "dist/index.js"));
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
        const filename = JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[")))[0].filename;
        dependencies[relative === "node_modules/zod-v3" ? "zod-v3" : metadata.name] = `file:${join(fixture, filename)}`;
      }
      await writeFile(
        join(fixture, "package.json"),
        JSON.stringify({ name: "harness-consumer-fixture", private: true, type: "module", dependencies }),
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
        "@modelcontextprotocol/client",
        "@a2a-js/sdk",
        "@huggingface/transformers",
        "twilio",
        "telnyx",
        "@vonage/server-sdk",
        "livekit-server-sdk",
      ]) {
        await expect(access(join(fixture, "node_modules", name))).rejects.toThrow();
      }
      const expression = `
      for (const name of ["createTwilioCallProvider", "createTelnyxCallProvider", "createExotelCallProvider", "createSignalWireCallProvider", "createVonageCallProvider", "createLiveKitSipCallProvider", "OutboundCallService"]) {
        if (typeof telephony[name] !== "function") throw new Error("Missing telephony export: " + name);
      }
      if(typeof harness.requestInputTool !== "function" || typeof harness.HarnessInputError !== "function" || typeof core.getCommunicationCapabilities !== "function") throw new Error("Missing conversational exports");
      if(typeof harness.mcpResources !== "function") throw new Error("Missing MCP resource ability");
      for (const schema of [z3.object({name:z3.string()}), z4.object({name:z4.string()}), mini.object({name:mini.string()})]) {
        const tool = core.defineTool({name:"echo",description:"echo",parameters:schema,execute:async(args)=>args.name});
        if(core.parseSchema(tool.parameters,{name:"hello"}).name !== "hello") throw new Error("Invalid schema parsing");
        if(core.convertJsonSchema(schema).schema.properties.name.type !== "string") throw new Error("Invalid schema conversion");
      }
      const definition = harness.defineHarness({id: "consumer", abilities: [harness.textContext({id:"notes", entries:[{id:"one", text:"hello"}]}, {instanceId:"notes"})]});
      if (harness.describeHarness(definition).id !== "consumer") throw new Error("Invalid package exports");
      if (harness.exportManifest(definition).contractVersion !== 1) throw new Error("Invalid manifest export");
      for (const name of ["HarnessRuntime", "HarnessResourcePool", "resolveHarnessRuntime"]) {
        if (name in core || typeof harness[name] !== "function") throw new Error("Harness ownership violation: " + name);
      }
      for (const name of ["LegacyMCPToolProvider", "A2ALegacyRemoteAgent", "ColbertReranker"]) {
        if (name in core) throw new Error("Removed compatibility export: " + name);
      }
      if ("deep" in core.Agent || "legacyDeep" in harness) throw new Error("Implicit deep preset still exported");
      for (const name of ["MCPToolProvider", "MCPV2ToolProvider", "A2ARemoteAgent", "CrossEncoderReranker"]) {
        if (typeof core[name] !== "function") throw new Error("Missing supported export: " + name);
      }`;
      await writeFile(
        join(fixture, "esm.mjs"),
        `import * as telephony from "@agentium/core/telephony"; import * as z3 from "zod-v3"; import * as z4 from "zod"; import * as mini from "zod/mini"; import * as core from "@agentium/core"; import * as harness from "@agentium/harness"; import * as testing from "@agentium/harness/testing"; if (!Object.keys(testing).length) throw new Error("Missing testing exports"); ${expression}`,
      );
      await writeFile(
        join(fixture, "common.cjs"),
        `const telephony = require("@agentium/core/telephony"); const z3 = require("zod-v3"); const z4 = require("zod"); const mini = require("zod/mini"); const core = require("@agentium/core"); const harness = require("@agentium/harness"); const testing = require("@agentium/harness/testing"); if (!Object.keys(testing).length) throw new Error("Missing testing exports"); ${expression}`,
      );
      await exec(process.execPath, [join(fixture, "esm.mjs")], { cwd: fixture });
      await exec(process.execPath, [join(fixture, "common.cjs")], { cwd: fixture });
      await writeFile(
        join(fixture, "consumer.ts"),
        `
      import { Agent, defineTool, getCommunicationCapabilities, type PublicMessageEvent, type InputRequest, type ModelProvider } from "@agentium/core";
      import * as z3 from "zod-v3";
      import * as z4 from "zod";
      import * as mini from "zod/mini";
      for (const parameters of [z3.object({name:z3.string()}), z4.object({name:z4.string()}), mini.object({name:mini.string()})]) {
        defineTool({name:"typed",description:"typed",parameters,execute:async(args)=>{ const name:string=args.name; return name; }});
      }
      import { type OutboundCallProvider } from "@agentium/core/telephony";
      const providers: OutboundCallProvider[] = [];
      const zod3Output = z3.object({ok:z3.boolean()});
      const zod4Output = z4.object({ok:z4.boolean()});
      import { defineAbility, defineHarness, textContext, agentDriver, HarnessRuntime, requestInputTool, type RunHandle, type HarnessRunState, type HarnessDefinition } from "@agentium/harness";
      const callback = defineAbility({type:"consumer/callback", validate:(options:{ callback:()=>string })=>options,
        describe:()=>({toolNames:[],requirements:[]}), bind:async(options)=>({tools:[],promptFragments:[{id:"hint",text:options.callback()}]})});
      const service = defineAbility({type:"consumer/service", validate:(options:{ service:{read():Promise<string>} })=>options,
        describe:()=>({toolNames:[],requirements:[]}), bind:async()=>({tools:[]})});
      const harness: HarnessDefinition = defineHarness({abilities:[callback({callback:()=>"hello"}), service({service:{read:async()=>"value"}}), textContext({id:"notes",entries:[]})]});
      declare const model: ModelProvider;
      declare const liveRun: RunHandle;
      const state: HarnessRunState = liveRun.state;
      const pending: InputRequest | undefined = liveRun.pendingInput;
      const response: Promise<void> = liveRun.reply(pending?.id ?? "request", "answer");
      const capability = getCommunicationCapabilities(model);
      requestInputTool();
      new Agent({name:"zod3",model,structuredOutput:zod3Output});
      new Agent({name:"zod4",model,structuredOutput:zod4Output});
      new HarnessRuntime({definition: harness, driver: agentDriver(new Agent({name:"consumer",model})), grants:{toolIds:[],modelRoles:["main"]}});
      // @ts-expect-error concrete runtime belongs to the harness package
      import { HarnessRuntime as CoreRuntime } from "@agentium/core";
      // @ts-expect-error removed implicit preset
      Agent.deep({name:"consumer",model});
      // @ts-expect-error configuration has one owner
      new Agent({name:"consumer",model,harness});
      // @ts-expect-error workspace authority must be explicit
      new Agent({name:"consumer",model,workspace:"."});
    `,
      );
      await writeFile(
        join(fixture, "consumer.cts"),
        `
        import { defineHarness, describeHarness } from "@agentium/harness";
        const definition = defineHarness({ id: "commonjs-types", abilities: [] });
        const name: string = describeHarness(definition).id;
      `,
      );
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
            types: [],
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
  120_000,
);
