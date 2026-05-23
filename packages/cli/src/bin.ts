#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { devServer } from "./commands/dev.js";
import { newProject } from "./commands/new.js";
import { publishPackage } from "./commands/publish.js";
import { installSkill } from "./commands/skills.js";

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/bin.js sits next to package.json (../package.json from dist/).
    for (const candidate of [resolve(here, "../package.json"), resolve(here, "./package.json")]) {
      try {
        return JSON.parse(readFileSync(candidate, "utf8")).version as string;
      } catch {}
    }
  } catch {}
  return "0.0.0";
}

const program = new Command();

program
  .name("agentium")
  .description("Command-line tool for scaffolding and managing Agentium projects")
  .version(readPackageVersion());

program
  .command("init <name>")
  .aliases(["new", "create"])
  .description("Scaffold a new Agentium project from a template")
  .option("-t, --template <name>", "Template name (basic, rag, voice, browser)", "basic")
  .action(async (name: string, opts: { template: string }) => {
    await newProject(name, opts.template);
  });

program
  .command("dev")
  .description("Run an Agentium app in dev mode with hot reload")
  .option("-e, --entry <path>", "Entry file", "./src/index.ts")
  .action(async (opts: { entry: string }) => {
    await devServer(opts.entry);
  });

const skills = program.command("skills").description("Manage skills");
skills
  .command("install <source>")
  .description("Install a skill from a git URL, npm package, or local path")
  .action(async (source: string) => {
    await installSkill(source);
  });

program
  .command("publish")
  .description("Publish the current package to npm (convenience wrapper around `npm publish`)")
  .option("--access <level>", "npm access level", "public")
  .action(async (opts: { access: string }) => {
    await publishPackage(opts.access);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
