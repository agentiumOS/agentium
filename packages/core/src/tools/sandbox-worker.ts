/**
 * Sandbox worker subprocess entry point.
 * Receives a serialized tool function + args via IPC, executes it, and sends back the result.
 *
 * NOTE: This sandbox provides process isolation but is NOT a security boundary.
 * The __SANDBOX_NO_NETWORK env var is a cooperative signal only; it does not enforce network restrictions.
 */

interface SandboxMessage {
  type: "execute";
  functionBody: string;
  args: Record<string, unknown>;
}

interface SandboxResult {
  type: "result";
  value: unknown;
}

interface SandboxError {
  type: "error";
  message: string;
  stack?: string;
}

process.on("message", async (msg: SandboxMessage) => {
  if (msg.type !== "execute") return;

  try {
    const fn = new Function("args", `return (async () => { ${msg.functionBody} })()`);
    const result = await fn(msg.args);

    const response: SandboxResult = { type: "result", value: result };
    process.send!(response);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    const response: SandboxError = {
      type: "error",
      message: error.message,
      stack: error.stack,
    };
    process.send!(response);
  }
});
