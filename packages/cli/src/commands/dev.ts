import { spawn } from "node:child_process";

/**
 * Run an Agentium app with hot reload via `tsx --watch`.
 * Requires `tsx` to be installed in the consuming project.
 */
export async function devServer(entry: string): Promise<void> {
  const child = spawn("npx", ["tsx", "--watch", entry], { stdio: "inherit" });
  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tsx exited with code ${code}`))));
    child.on("error", reject);
  });
}
