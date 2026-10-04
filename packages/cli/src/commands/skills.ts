import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

/** Install a dependency or validate a local SKILL.md; applications register skills explicitly. */
export async function installSkill(source: string): Promise<void> {
  if (!source || source.startsWith("-") || /[\x00-\x1f\x7f]/.test(source))
    throw new Error("Provide one npm package, Git package URL, or local skill path; npm flags are not accepted");
  if (isAbsolute(source) || source.startsWith("./") || source.startsWith("../")) {
    const path = resolve(source);
    let entry: string;
    try {
      const info = await stat(path);
      entry = info.isDirectory() ? resolve(path, "SKILL.md") : path;
      if (basename(entry) !== "SKILL.md" || !(await stat(entry)).isFile()) throw new Error("Missing SKILL.md");
      await access(entry, constants.R_OK);
    } catch {
      throw new Error(`Local skill must be a readable SKILL.md file or a directory containing it: ${source}`);
    }
    console.log(`Local skill validated: ${entry}`);
    console.log("Next: register its directory explicitly in your application's skills or harness configuration.");
    return;
  }
  if (/\s/.test(source)) throw new Error("Provide one npm package or Git URL without whitespace");
  console.log(`Installing skill dependency through npm: ${source}`);
  await runCmd(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--ignore-scripts", "--", source]);
  console.log(
    "Installed dependency. Follow its README to register its tools or skill directory explicitly; install scripts were disabled.",
  );
}

function runCmd(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${signal ?? code}`)),
    );
    child.on("error", reject);
  });
}
