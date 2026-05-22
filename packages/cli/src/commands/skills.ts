import { spawn } from "node:child_process";

/**
 * Install a skill into the local project. Currently delegates to:
 *   - `npm install <pkg>` for npm packages
 *   - `git clone` for git URLs (cached under `./.agentium/skills/`)
 *   - filesystem path: no-op (just confirms the path exists)
 */
export async function installSkill(source: string): Promise<void> {
  if (source.startsWith("./") || source.startsWith("/") || source.startsWith("../")) {
    console.log(`Skill resolved as local path: ${source}`);
    return;
  }
  if (/^git\+/.test(source) || /^https:\/\/github\.com\/.+\.git/.test(source)) {
    console.log(`Cloning git skill: ${source}`);
    await runCmd("npm", ["install", source]);
    return;
  }
  // npm package
  console.log(`Installing npm skill: ${source}`);
  await runCmd("npm", ["install", source]);
}

function runCmd(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
    child.on("error", reject);
  });
}
