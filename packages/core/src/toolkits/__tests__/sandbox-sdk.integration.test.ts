import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaytonaSandbox, type DaytonaSandboxSDK } from "../sandbox-daytona.js";
import { E2BSandbox, type E2BSandboxSDK } from "../sandbox-e2b.js";

// Install exact optional SDKs into an isolated prefix. All endpoints below are loopback fixtures;
// no provider credentials, account creation, cloud sandbox or paid service is used.
const prefix = process.env.AGENTIUM_SANDBOX_SDK_PREFIX;
describe.skipIf(!prefix)("installed sandbox SDKs against a local controlled server", () => {
  it("verifies E2B 2.8.0 and Daytona 0.220.0 create/code/files/delete wire mappings", async () => {
    const load = createRequire(join(prefix!, "package.json"));
    for (const [name, version] of [
      ["@e2b/code-interpreter", "2.8.0"],
      ["@daytona/sdk", "0.220.0"],
    ]) {
      const pkg = JSON.parse(await readFile(join(prefix!, "node_modules", name, "package.json"), "utf8"));
      expect(pkg.version).toBe(version);
    }
    const e2bSDK = load("@e2b/code-interpreter");
    const daytonaSDK = load("@daytona/sdk");
    const requests: { method: string; path: string; body?: any }[] = [];
    const files = new Map<string, Buffer>();
    let base = "";
    let daytonaLabels: Record<string, string> = {};
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, base);
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(Buffer.from(part));
        const bytes = Buffer.concat(parts);
        const body =
          req.headers["content-type"]?.includes("json") && bytes.length ? JSON.parse(bytes.toString()) : undefined;
        requests.push({ method: req.method!, path: url.pathname, body });
        const json = (value: unknown, status = 200) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        if (req.method === "POST" && url.pathname === "/v2/sandboxes") {
          json({ sandboxID: "e2b-fixture", envdVersion: "0.6.2" });
          return;
        }
        if (url.pathname === "/execute") {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.end(`${JSON.stringify({ type: "stdout", text: "sdk-output" })}\n`);
          return;
        }
        if (url.pathname === "/files" && req.method === "POST") {
          const form = await new Response(bytes, {
            headers: { "content-type": req.headers["content-type"]! },
          }).formData();
          const file = form.get("file") as File;
          files.set(url.searchParams.get("path")!, Buffer.from(await file.arrayBuffer()));
          json([{ name: "blob", path: "blob", type: "file" }]);
          return;
        }
        if (url.pathname === "/files" && req.method === "GET") {
          res.end(files.get(url.searchParams.get("path")!)!);
          return;
        }
        if (url.pathname === "/sandboxes/e2b-fixture" && req.method === "DELETE") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (url.pathname === "/api/sandbox" && req.method === "POST") {
          daytonaLabels = body.labels;
          json({ id: "daytona-fixture", state: "started", labels: body.labels, toolboxProxyUrl: `${base}/toolbox` });
          return;
        }
        if (url.pathname.endsWith("/process/code-run") || url.pathname.endsWith("/process/execute")) {
          json({ result: "sdk-output", exitCode: 7 });
          return;
        }
        if (url.pathname.endsWith("/files/bulk-upload")) {
          const form = await new Response(bytes, {
            headers: { "content-type": req.headers["content-type"]! },
          }).formData();
          const file = form.get("files[0].file") as File;
          files.set(String(form.get("files[0].path")), Buffer.from(await file.arrayBuffer()));
          json({});
          return;
        }
        if (url.pathname.endsWith("/files/bulk-download")) {
          const path = body.paths[0];
          const boundary = "agentium-sdk-fixture";
          res.writeHead(200, { "content-type": `multipart/form-data; boundary=${boundary}` });
          res.end(
            Buffer.concat([
              Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
              ),
              files.get(path)!,
              Buffer.from(`\r\n--${boundary}--\r\n`),
            ]),
          );
          return;
        }
        if (url.pathname === "/api/sandbox/daytona-fixture" && req.method === "DELETE") {
          json({
            id: "daytona-fixture",
            state: "destroyed",
            labels: daytonaLabels,
            toolboxProxyUrl: `${base}/toolbox`,
          });
          return;
        }
        json({ message: `Unexpected fixture endpoint ${req.method} ${url.pathname}` }, 404);
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const e2b = new E2BSandbox({
      apiKey: "local-fixture-not-a-secret",
      sdk: {
        Sandbox: {
          create: (options) =>
            e2bSDK.Sandbox.create({ ...options, apiUrl: base, sandboxUrl: base, validateApiKey: false, retries: 0 }),
        },
      } as E2BSandboxSDK,
    });
    // Polling is selected only in this wire fixture to avoid a WebSocket service unrelated to these calls.
    class FixtureDaytona extends daytonaSDK.Daytona {
      constructor(config: object) {
        super({ ...config, useDeprecatedPolling: true });
      }
    }
    const daytona = new DaytonaSandbox({
      apiKey: "local-fixture-not-a-secret",
      baseURL: `${base}/api`,
      language: "node",
      sdk: { Daytona: FixtureDaytona } as unknown as DaytonaSandboxSDK,
    });
    try {
      await Promise.all([e2b.start(), e2b.start()]);
      expect(await e2b.run("literal", { language: "node", env: { X: "1" }, timeoutSeconds: 2 })).toEqual({
        output: "sdk-output",
        exitCode: 0,
      });
      await e2b.writeFile("e2b-blob", "AP+A", "base64");
      expect(await e2b.readFile("e2b-blob", "base64")).toBe("AP+A");
      await e2b.close();
      await Promise.all([daytona.start(), daytona.start()]);
      expect(await daytona.run("literal", { env: { X: "1" }, timeoutSeconds: 2 })).toEqual({
        output: "sdk-output",
        exitCode: 7,
      });
      expect(await daytona.shell("exit 7", { timeoutSeconds: 3 })).toEqual({ output: "sdk-output", exitCode: 7 });
      await daytona.writeFile("daytona-blob", "AP+A", "base64");
      expect(await daytona.readFile("daytona-blob", "base64")).toBe("AP+A");
      await daytona.close();
      expect(requests.filter((r) => r.path === "/v2/sandboxes")).toHaveLength(1);
      expect(requests.find((r) => r.path === "/v2/sandboxes")?.body).toMatchObject({
        templateID: "code-interpreter-v1",
        timeout: 300,
      });
      expect(requests.find((r) => r.path === "/execute")?.body).toEqual({
        code: "literal",
        language: "javascript",
        env_vars: { X: "1" },
      });
      expect(requests.find((r) => r.path.endsWith("/process/code-run"))?.body).toMatchObject({
        code: "literal",
        language: "javascript",
        envs: { X: "1" },
        timeout: 2,
      });
      expect(requests.find((r) => r.path.endsWith("/process/execute"))?.body).toMatchObject({
        command: "exit 7",
        timeout: 3,
      });
      expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
    } finally {
      await Promise.allSettled([e2b.close(), daytona.close()]);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }, 20000);
});
