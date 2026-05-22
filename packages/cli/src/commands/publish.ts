import { spawn } from "node:child_process";

export async function publishPackage(access: string): Promise<void> {
  const child = spawn("npm", ["publish", `--access=${access}`], { stdio: "inherit" });
  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm publish exited with ${code}`))));
    child.on("error", reject);
  });
}
