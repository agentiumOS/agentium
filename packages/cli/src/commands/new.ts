import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const TEMPLATES = ["basic", "rag", "voice", "browser"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

interface Template {
  files: Record<string, string>;
}

const basicTemplate: Template = {
  files: {
    "package.json": JSON.stringify(
      {
        name: "__PROJECT_NAME__",
        version: "0.1.0",
        type: "module",
        dependencies: {
          "@agentium/core": "*",
          openai: "*",
        },
        devDependencies: {
          tsx: "^4.0.0",
          typescript: "^5.0.0",
        },
        scripts: {
          start: "tsx src/index.ts",
        },
      },
      null,
      2,
    ),
    "src/index.ts": [
      'import { Agent, openai } from "@agentium/core";',
      "",
      "const agent = new Agent({",
      '  name: "assistant",',
      '  model: openai("gpt-4o"),',
      '  instructions: "You are a helpful assistant.",',
      "});",
      "",
      'const result = await agent.run("Hello!");',
      "console.log(result.text);",
      "",
    ].join("\n"),
    "tsconfig.json": JSON.stringify(
      { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true } },
      null,
      2,
    ),
    ".gitignore": "node_modules\ndist\n.env\n",
  },
};

const ragTemplate: Template = {
  files: {
    ...basicTemplate.files,
    "src/index.ts": [
      'import { Agent, openai, OpenAIEmbedding, InMemoryVectorStore } from "@agentium/core";',
      "",
      "const embedder = new OpenAIEmbedding();",
      "const store = new InMemoryVectorStore(embedder);",
      "",
      'await store.upsert("docs", { id: "1", content: "Agentium is a TypeScript agent framework." });',
      "",
      "const agent = new Agent({",
      '  name: "rag",',
      '  model: openai("gpt-4o"),',
      '  instructions: "Answer using the retrieved context.",',
      "});",
      "",
      'const hits = await store.search("docs", "What is Agentium?", { topK: 3 });',
      "console.log(hits);",
      "",
    ].join("\n"),
  },
};

const voiceTemplate: Template = {
  files: {
    ...basicTemplate.files,
    "src/index.ts": [
      'import { VoiceAgent, openai } from "@agentium/core";',
      "",
      "// See https://github.com/agentiumOS/agentium-docs/voice for the full setup.",
      "const agent = new VoiceAgent({",
      '  name: "voice-bot",',
      '  model: openai("gpt-realtime"),',
      '  instructions: "You are a friendly voice assistant.",',
      "});",
      "",
      'console.log("Voice agent ready - wire it to a transport gateway to start a session.");',
      "",
    ].join("\n"),
  },
};

const browserTemplate: Template = {
  files: {
    ...basicTemplate.files,
    "package.json": basicTemplate.files["package.json"].replace(
      '"openai": "*"',
      '"openai": "*",\n    "@agentium/browser": "*",\n    "playwright": "*"',
    ),
    "src/index.ts": [
      'import { BrowserAgent } from "@agentium/browser";',
      'import { openai } from "@agentium/core";',
      "",
      "const agent = new BrowserAgent({",
      '  model: openai("gpt-4o"),',
      '  instructions: "You browse the web on the user\'s behalf.",',
      "  headless: false,",
      "});",
      "",
      'const result = await agent.run("Find the latest stable Node.js release version on nodejs.org");',
      "console.log(result.result);",
      "await agent.close();",
      "",
    ].join("\n"),
  },
};

const templates: Record<TemplateName, Template> = {
  basic: basicTemplate,
  rag: ragTemplate,
  voice: voiceTemplate,
  browser: browserTemplate,
};

export async function newProject(name: string, templateName: string): Promise<void> {
  if (!TEMPLATES.includes(templateName as TemplateName)) {
    throw new Error(`Unknown template "${templateName}". Available: ${TEMPLATES.join(", ")}`);
  }
  const template = templates[templateName as TemplateName];
  const root = resolve(process.cwd(), name);
  await mkdir(root, { recursive: true });

  for (const [rel, body] of Object.entries(template.files)) {
    const full = resolve(root, rel);
    await mkdir(resolve(full, ".."), { recursive: true });
    await writeFile(full, body.replace(/__PROJECT_NAME__/g, name));
  }

  console.log(`Created Agentium project at ${root}`);
  console.log("Next steps:");
  console.log(`  cd ${name}`);
  console.log("  npm install");
  console.log("  npm start");
}
