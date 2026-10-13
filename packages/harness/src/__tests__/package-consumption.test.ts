import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const enabled = process.env.AGENTIUM_TEST_PACKAGES === "1";

async function retainedArtifact(metadata: { name: string; version: string }): Promise<string | undefined> {
  const directory = process.env.AGENTIUM_RELEASE_ARTIFACT_DIR;
  if (!directory) return undefined;
  const manifest: { packages: { name: string; version: string; filename: string; sha256: string }[] } = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  const entry = manifest.packages.find((entry) => entry.name === metadata.name);
  if (!entry || entry.version !== metadata.version || basename(entry.filename) !== entry.filename)
    throw new Error(`Retained release artifact identity mismatch: ${metadata.name}`);
  const path = resolve(directory, entry.filename);
  expect(
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  ).toBe(entry.sha256);
  return path;
}

async function assertGuideLinks(packageDirectory: string, guide: string, labels: string[]) {
  const path = join(packageDirectory, guide);
  const document = await readFile(path, "utf8");
  const links = [...document.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
  for (const label of labels) {
    const link = links.find((match) => match[1] === label);
    if (!link) throw new Error(`Missing guide link: ${guide} -> ${label}`);
    const target = link[2];
    const repositoryPrefix = "https://github.com/agentiumOS/agentium/blob/main/";
    if (target.startsWith("https://")) {
      expect(target).toMatch(/^https:\/\/github\.com\/agentiumOS\/agentium\/blob\/main\//);
      expect((await readFile(join(root, target.slice(repositoryPrefix.length)), "utf8")).trim()).not.toBe("");
    } else {
      const linkedPath = resolve(dirname(path), target);
      expect(linkedPath.startsWith(`${packageDirectory}${sep}`)).toBe(true);
      expect((await readFile(linkedPath, "utf8")).trim()).not.toBe("");
    }
  }
}

async function assertCoreGuides(fixture: string) {
  await assertGuideLinks(join(fixture, "node_modules/@agentium/core"), "README.md", [
    "storage identities and migration",
    "workflow contract",
    "dependability guide",
  ]);
}

// Explicit post-build gate: ordinary source tests must not accidentally validate stale dist artifacts.
it.skipIf(!enabled).each([false, true])(
  "consumes packed core+harness via ESM, CommonJS and public TypeScript without optional SDKs (eval=%s)",
  async (withEval) => {
    const fixture = await mkdtemp(join(tmpdir(), "agentium-packed-harness-"));
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    try {
      const dependencies: Record<string, string> = {};
      for (const relative of [
        "packages/core",
        "packages/harness",
        ...(withEval ? ["packages/eval"] : []),
        "node_modules/zod",
        "node_modules/zod-v3",
        "node_modules/zod-to-json-schema",
      ]) {
        const directory =
          relative === "packages/harness" && process.env.AGENTIUM_HARNESS_PACKAGE_DIR
            ? process.env.AGENTIUM_HARNESS_PACKAGE_DIR
            : join(root, relative);
        const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        // The explicit negative-fixture override must still replace the harness package.
        const retained =
          relative.startsWith("packages/") &&
          !(relative === "packages/harness" && process.env.AGENTIUM_HARNESS_PACKAGE_DIR)
            ? await retainedArtifact(metadata)
            : undefined;
        if (retained) {
          dependencies[metadata.name] = `file:${retained}`;
          continue;
        }
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
      await assertGuideLinks(join(fixture, "node_modules/@agentium/harness"), "README.md", [
        "dependability guide",
        "execution graph guide",
      ]);
      await assertGuideLinks(join(fixture, "node_modules/@agentium/harness"), "DEPENDABILITY.md", [
        "indexed fixture",
        "runtime tests",
        "memory acceptance runner",
        "workflow contract",
        "storage guide",
      ]);
      await assertCoreGuides(fixture);
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
      if (!withEval) await expect(access(join(fixture, "node_modules/@agentium/eval"))).rejects.toThrow();
      const expression = `
      for (const name of ["verifiedCompletionPolicy", "continuityContextPolicy", "currentSessionRecallPolicy", "incrementalTaskSummaryPolicy"]) {
        if (typeof harness[name] !== "function") throw new Error("Missing dependability export: " + name);
      }
      for (const name of ["AgentLifecycleError", "MemoryDrainError", "ModelProtocolError", "WorkflowMergeConflict", "WorkflowCheckpointError", "WorkflowCancellationError"]) {
        if (typeof core[name] !== "function") throw new Error("Missing core error export: " + name);
      }
      if (typeof testing.createHarnessEvalTarget !== "function" || "createHarnessEvalTarget" in harness) throw new Error("Testing subpath ownership violation");
      for (const name of ["createTwilioCallProvider", "createTelnyxCallProvider", "createExotelCallProvider", "createSignalWireCallProvider", "createVonageCallProvider", "createLiveKitSipCallProvider", "OutboundCallService"]) {
        if (typeof telephony[name] !== "function") throw new Error("Missing telephony export: " + name);
      }
      for (const name of ["validateRunInput", "parseRunInput"]) {
        if (typeof harness[name] !== "function") throw new Error("Missing input validation export: " + name);
      }
      if (harness.RUN_INPUT_LIMITS.maxNormalizedBytes !== 65536 || harness.parseRunInput('"ok"') !== "ok") throw new Error("Inconsistent input metadata");
      for (const name of ["ModelDeadlineError", "ModelCapabilityError", "EndpointCompatibilityError", "validateModelRequest"]) {
        if (typeof core[name] !== "function") throw new Error("Missing model control export: " + name);
      }
      if(typeof harness.requestInputTool !== "function" || typeof harness.HarnessInputError !== "function" || typeof core.getCommunicationCapabilities !== "function") throw new Error("Missing conversational exports");
      if(typeof harness.mcpResources !== "function") throw new Error("Missing MCP resource ability");
      for (const name of ["ExecutionGraphRuntime", "validateExecutionPlan", "graphCatalogDigest", "ExecutionPlanValidationError"]) {
        if (typeof harness[name] !== "function" || name in core) throw new Error("Graph adapter ownership violation: " + name);
      }
      for (const name of ["DurableGraphJournal", "RootExecutionController", "validateRootExecutionCounts"]) {
        if (typeof core[name] !== "function") throw new Error("Missing graph core boundary: " + name);
      }
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
      for (const name of ["MCPToolProvider", "MCPV2ToolProvider", "A2ARemoteAgent", "CrossEncoderReranker", "WorkflowDefinitionError"]) {
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
      const offline = `
        const domain = z4.object({value:z4.string()});
        const binding = {id:"echo",version:"1",kind:"tool",input:domain,output:z4.string(),recovery:"pure",
          tool:{name:"echo",description:"echo",parameters:domain,execute:async(args)=>args.value}};
        const controlled = new harness.ExecutionGraphRuntime({catalog:[binding],program:{id:"packed",version:"1",plan:{schemaVersion:1,revision:1,nodes:[{id:"answer",binding:"echo",version:"1",args:{value:"hello"}}]}},
          limits:{maxConcurrentWork:1,maxExpandedNodes:1,maxWorkAttempts:1,maxPlanRevisions:1},harness:{grants:{toolIds:["echo"],modelRoles:[]},budgets:{maxToolCalls:1,maxModelCalls:0}}});
        await controlled.create({id:"task",input:{},identity:{tenantId:"fixture",actorId:"fixture",sessionId:"packed",runId:"run",rootRunId:"run"}});
        const recovered = await controlled.run({tenantId:"fixture",taskId:"task"},"worker");
        if(controlled.capabilities.durable || recovered.task.state!=="completed" || recovered.output.answer!=="hello" || recovered.graph.budget.usedTools!==1 || recovered.graph.admission.workAttempts!==1) throw new Error("Packed controlled graph failed");
        const graphWorkflow = new core.Workflow({name:"packed-graph",register:false,initialState:{left:0,right:0,total:0,checked:false},steps:[{
          name:"repair",maxIterations:1,while:state=>!state.checked,repeat:[{
            name:"calculate",maxConcurrency:2,graph:()=>[
              {id:"left",step:{name:"read",run:async()=>({left:2})}},
              {id:"right",step:{name:"read",run:async()=>({right:3})}},
              {id:"sum",inputsFrom:["left","right"],step:{name:"sum",run:async state=>({total:state.left+state.right,checked:true})}}
            ]
          }]
        }]});
        const graphRuntime = new harness.HarnessRuntime({driver:harness.workflowDriver(graphWorkflow),grants:{toolIds:["workflow:repair/0/calculate/left/read","workflow:repair/0/calculate/right/read","workflow:repair/0/calculate/sum/sum"],modelRoles:[]},budgets:{maxToolCalls:3,maxModelCalls:0}});
        const graphResult = await graphRuntime.run("{}",{identity:{tenantId:"fixture",userId:"fixture"},sessionId:"packed-graph"});
        if(graphResult.status!=="completed" || graphResult.structured?.total!==5 || graphResult.budget?.toolCalls.used!==3) throw new Error("Packed workflow graph failed");
        const model = {providerId:"fixture",modelId:"fixture",generate:async()=>({message:{role:"assistant",content:"packed answer"},finishReason:"stop",usage:{promptTokens:1,completionTokens:1,totalTokens:2},raw:{}}),async *stream(){}};
        const config = {driver:harness.agentDriver({name:"packed",model}),grants:{toolIds:[],modelRoles:["main"]},completionPolicy:harness.verifiedCompletionPolicy({verifier:{verify:async()=>({verdict:"pass",reason:"Host fixture checked current candidate",evidence:["fixture:current"]})}})};
        const target = testing.createHarnessEvalTarget({config,identity:{tenantId:"fixture",userId:"fixture"}});
        ${
          withEval
            ? `const suite = new evaluation.EvalSuite({name:"packed eval",agent:target,cases:[{name:"case",input:"packed input"}],scorers:[evaluation.contains("packed answer")]});
        const report = await suite.run();
        if (report.passed !== 1 || report.gradedCases !== 1 || report.gradedAverageScore !== 1) throw new Error("Packed harness evaluation failed");`
            : `const output = await target.run("packed input");
        if (output.status !== "completed" || output.text !== "packed answer" || target.observation(output)?.toolCallCoverage !== "complete") throw new Error("Packed harness target failed");`
        }
      `;
      await writeFile(
        join(fixture, "offline.mjs"),
        `import * as z4 from "zod"; import * as core from "@agentium/core"; import * as harness from "@agentium/harness"; import * as testing from "@agentium/harness/testing"; ${withEval ? 'import * as evaluation from "@agentium/eval";' : ""} ${offline}`,
      );
      await writeFile(
        join(fixture, "offline.cjs"),
        `const z4 = require("zod"); const core = require("@agentium/core"); const harness = require("@agentium/harness"); const testing = require("@agentium/harness/testing"); ${withEval ? 'const evaluation = require("@agentium/eval");' : ""} (async()=>{${offline}})().catch(error=>{console.error(error);process.exitCode=1;});`,
      );
      await exec(process.execPath, [join(fixture, "offline.mjs")], { cwd: fixture });
      await exec(process.execPath, [join(fixture, "offline.cjs")], { cwd: fixture });
      await writeFile(
        join(fixture, "consumer.ts"),
        `
      import { Agent, defineTool, getCommunicationCapabilities, type PublicMessageEvent, type InputRequest, type ModelProvider } from "@agentium/core";
      import { type OpenAIConfig, type AnthropicConfig, type ModelCapabilities, type ProviderRequestControls, validateModelRequest } from "@agentium/core";
      import { validateRunInput, parseRunInput, RUN_INPUT_LIMITS, type HarnessBudgetSnapshot, type HistoryArchive, type ResidentHistoryPolicy } from "@agentium/harness";
      import { type AgentCloseOptions, type MemoryDrainResult, type RememberResult, type ScopedStorageOptions, type WorkflowContinuationOptions } from "@agentium/core";
      import { verifiedCompletionPolicy, continuityContextPolicy, currentSessionRecallPolicy, incrementalTaskSummaryPolicy, type RecallBudget, type RecallStore, type RecallScope, type TaskSummaryRecord } from "@agentium/harness";
      import { createHarnessEvalTarget, type HarnessEvalTarget } from "@agentium/harness/testing";

      import { Workflow, WorkflowDefinitionError, type GraphStep, type WorkflowGraphNode, type RepeatStep, type StepDef, type StepResult } from "@agentium/core";
      import { workflowDriver } from "@agentium/harness";
      import { ExecutionGraphRuntime, type ExecutionGraphProgram, type ExecutionGraphLimits, type GraphToolBinding, type PlanCommitFrame, type HarnessBudgetState } from "@agentium/harness";
      import { RootExecutionController, type DurableGraphState, type RootExecutionLimits } from "@agentium/core";
      const controlledLimits: ExecutionGraphLimits = {maxConcurrentWork:1,maxExpandedNodes:2,maxWorkAttempts:3,maxPlanRevisions:2};
      const controller = new RootExecutionController(controlledLimits as RootExecutionLimits);
      const program: ExecutionGraphProgram = {id:"public",version:"1",plan:{schemaVersion:1,revision:1,nodes:[]}};
      const frame: PlanCommitFrame = {baseRevision:0,plan:program.plan!};
      new ExecutionGraphRuntime({program,catalog:[],limits:controlledLimits,harness:{grants:{toolIds:[],modelRoles:[]}}});
      type GraphState = {count:number};
      const node: WorkflowGraphNode<GraphState> = {id:"a",step:{name:"produce",run:async state=>({count:state.count+1})}};
      const graph: GraphStep<GraphState> = {name:"episode",graph:()=>[node],maxConcurrency:2,merge:"error"};
      const repeat: RepeatStep<GraphState> = {name:"repair",repeat:[graph],maxIterations:2,while:state=>state.count<2};
      const steps: StepDef<GraphState>[] = [repeat];
      const row: StepResult = {stepName:"produce",status:"done",durationMs:0,executionPath:"episode/a/produce",reason:{code:"fixture",message:"verified"}};
      const invalid = new WorkflowDefinitionError("Invalid host graph");
      workflowDriver(new Workflow({name:"typed-graph",register:false,initialState:{count:0},steps}));
      const scopedOptions: ScopedStorageOptions = {keyEncoding:"tuple-v1",ownsInner:false};
      const closeOptions: AgentCloseOptions = {closeStorage:false,memoryDrain:{timeoutMs:5000}};
      const verifier = verifiedCompletionPolicy({verifier:{verify:async()=>({verdict:"unknown",reason:"Missing current evidence"})}});
      continuityContextPolicy({id:"context",maxRequestTokens:8000,reservedRequestTokens:1000});
      currentSessionRecallPolicy("current");
      incrementalTaskSummaryPolicy({id:"summary",version:1,modelRole:"summary",maxInputBytes:16000,maxOutputBytes:2048,maxTokens:512,maxEvidenceReferences:8,maxUncertainties:4});
      const controls: ProviderRequestControls = {maxRetries: 0, sdkMaxRetries: 0, timeoutMs: 100, callTimeoutMs: 200};
      const openAIConfig: OpenAIConfig = {...controls, endpoint: "responses", fallback: "error"};
      const anthropicConfig: AnthropicConfig = {...controls, baseURL: "https://example.test"};
      const capabilities: ModelCapabilities = {contextWindow: 1000, tools: true, maxOutputTokens: 100};
      validateModelRequest(capabilities, [], {maxTokens: 100});
      const input = validateRunInput(parseRunInput('"hello"'));
      const maxBytes: number = RUN_INPUT_LIMITS.maxEncodedBytes;
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
      const target: HarnessEvalTarget = createHarnessEvalTarget({config:{driver:agentDriver({name:"target",model}),grants:{toolIds:[],modelRoles:["main"]}},identity:{tenantId:"t",userId:"u"}});
      ${
        withEval
          ? `import { EvalSuite, type EvalTarget, contains } from "@agentium/eval";
      const concrete: EvalTarget = new Agent({name:"core-target",model});
      const literal: EvalTarget = {run:async(input,opts)=>({text:typeof input==="string"?input:"media",usage:{promptTokens:0,completionTokens:0,totalTokens:0},toolCalls:[],status:"completed"})};
      new EvalSuite({name:"consumer",agent:target,cases:[{name:"hello",input:"hello"}],scorers:[contains("hello")]});`
          : ""
      }
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
        import { verifiedCompletionPolicy, continuityContextPolicy, type RecallStore, type TaskSummaryRecord } from "@agentium/harness";
        import { createHarnessEvalTarget, type HarnessEvalTarget } from "@agentium/harness/testing";
        import { type AgentCloseOptions, type ScopedStorageOptions, type ModelProvider, Agent } from "@agentium/core";

      import { Workflow, WorkflowDefinitionError, type GraphStep, type WorkflowGraphNode, type RepeatStep, type StepDef, type StepResult } from "@agentium/core";
      import { workflowDriver } from "@agentium/harness";
      type GraphState = {count:number};
      const node: WorkflowGraphNode<GraphState> = {id:"a",step:{name:"produce",run:async state=>({count:state.count+1})}};
      const graph: GraphStep<GraphState> = {name:"episode",graph:()=>[node],maxConcurrency:2,merge:"error"};
      const repeat: RepeatStep<GraphState> = {name:"repair",repeat:[graph],maxIterations:2,while:state=>state.count<2};
      const steps: StepDef<GraphState>[] = [repeat];
      const row: StepResult = {stepName:"produce",status:"done",durationMs:0,executionPath:"episode/a/produce",reason:{code:"fixture",message:"verified"}};
      const invalid = new WorkflowDefinitionError("Invalid host graph");
      workflowDriver(new Workflow({name:"typed-graph",register:false,initialState:{count:0},steps}));
        const closeOptions: AgentCloseOptions = {memoryDrain:{timeoutMs:100}};
        const scopedOptions: ScopedStorageOptions = {keyEncoding:"tuple-v1"};
        const verifier = verifiedCompletionPolicy({verifier:{verify:async()=>({verdict:"pass",reason:"Current host evidence"})}});
        ${
          withEval
            ? `import { type EvalTarget } from "@agentium/eval";
        declare const model: ModelProvider;
        const agentTarget: EvalTarget = new Agent({name:"cjs",model});
        const literal: EvalTarget = {run:async()=>({text:"ok",toolCalls:[],usage:{promptTokens:0,completionTokens:0,totalTokens:0}})};`
            : ""
        }
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

it.skipIf(!enabled)(
  "runs an ordinary packed core Agent without harness, eval or provider SDKs",
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), "agentium-packed-core-only-"));
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    try {
      const dependencies: Record<string, string> = {};
      for (const relative of [
        "packages/core",
        "node_modules/zod",
        "node_modules/zod-v3",
        "node_modules/zod-to-json-schema",
      ]) {
        const directory = join(root, relative);
        const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        const retained = relative.startsWith("packages/") ? await retainedArtifact(metadata) : undefined;
        if (retained) {
          dependencies[metadata.name] = `file:${retained}`;
          continue;
        }
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
        JSON.stringify({ name: "core-only-fixture", private: true, type: "module", dependencies }),
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
      await assertCoreGuides(fixture);
      for (const name of ["@agentium/harness", "@agentium/eval", "openai", "@anthropic-ai/sdk", "ioredis"])
        await expect(access(join(fixture, "node_modules", name))).rejects.toThrow();
      const source = `
      const provider = {providerId:"fixture",modelId:"fixture",generate:async()=>({message:{role:"assistant",content:"ordinary answer"},finishReason:"stop",usage:{promptTokens:1,completionTokens:1,totalTokens:2},raw:{}}),async *stream(){}};
      const tool = core.defineTool({name:"echo",description:"echo",parameters:z.object({text:z.string()}),execute:async({text})=>text});
      const agent = new core.Agent({name:"ordinary",model:provider,tools:[tool],register:false});
      const result = await agent.run("hello", {signal:new AbortController().signal});
      if (result.status !== "completed" || result.text !== "ordinary answer") throw new Error("Core-only execution failed");
      await agent.close();
    `;
      await writeFile(
        join(fixture, "ordinary.mjs"),
        `import * as core from "@agentium/core"; import {z} from "zod/v3"; ${source}`,
      );
      await writeFile(
        join(fixture, "ordinary.cjs"),
        `const core=require("@agentium/core"); const {z}=require("zod/v3"); (async()=>{${source}})().catch(error=>{console.error(error);process.exitCode=1;});`,
      );
      await exec(process.execPath, [join(fixture, "ordinary.mjs")], { cwd: fixture });
      await exec(process.execPath, [join(fixture, "ordinary.cjs")], { cwd: fixture });
      const types = `import {Agent, type AgentCloseOptions, type ModelProvider, ScopedStorage, InMemoryStorage} from "@agentium/core";
      declare const model:ModelProvider; const agent=new Agent({name:"ordinary",model});
      const options:AgentCloseOptions={memoryDrain:{timeoutMs:100}}; agent.close(options);
      new ScopedStorage(new InMemoryStorage(),{tenantId:"t",userId:"u"},{keyEncoding:"tuple-v1",ownsInner:false});`;
      await writeFile(join(fixture, "ordinary.ts"), types);
      await writeFile(join(fixture, "ordinary.cts"), types);
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
          files: ["ordinary.ts", "ordinary.cts"],
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
