import { createRequire } from "node:module";
import type { RouterOptions } from "./types.js";

const _require = createRequire(import.meta.url);

export interface RemoteEndpoint {
  baseUrl: string;
  agents?: string[];
  teams?: string[];
  workflows?: string[];
  headers?: Record<string, string>;
  healthPath?: string;
}

export interface GatewayConfig {
  locals?: RouterOptions;
  remotes: RemoteEndpoint[];
  healthCheckIntervalMs?: number;
}

export function createGatewayRouter(config: GatewayConfig) {
  let express: any;
  try {
    express = _require("express");
  } catch {
    throw new Error("express is required for gateway router. Install it: npm install express");
  }

  const router = express.Router();

  const remoteHealth = new Map<string, boolean>();

  async function checkHealth(remote: RemoteEndpoint): Promise<boolean> {
    try {
      const path = remote.healthPath ?? "/agents";
      const res = await fetch(`${remote.baseUrl}${path}`, {
        headers: remote.headers ?? {},
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  if (config.healthCheckIntervalMs) {
    const interval = setInterval(async () => {
      for (const remote of config.remotes) {
        const healthy = await checkHealth(remote);
        remoteHealth.set(remote.baseUrl, healthy);
      }
    }, config.healthCheckIntervalMs);
    (interval as any).unref?.();
  }

  async function proxyRequest(baseUrl: string, path: string, req: any, res: any, headers?: Record<string, string>) {
    try {
      const proxyRes = await fetch(`${baseUrl}${path}`, {
        method: req.method,
        headers: {
          "Content-Type": "application/json",
          ...(headers ?? {}),
          ...Object.fromEntries(
            Object.entries(req.headers).filter(([k]) => k.startsWith("x-") || k === "authorization"),
          ),
        },
        body: req.method !== "GET" ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });

      const contentType = proxyRes.headers.get("content-type") ?? "";

      if (contentType.includes("text/event-stream")) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const reader = proxyRes.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
          }
        }
        res.end();
      } else {
        const data = await proxyRes.json();
        res.status(proxyRes.status).json(data);
      }
    } catch (err: any) {
      res.status(502).json({ error: `Gateway proxy error: ${err.message}` });
    }
  }

  for (const remote of config.remotes) {
    if (remote.agents) {
      for (const agentName of remote.agents) {
        router.post(`/agents/${agentName}/run`, (req: any, res: any) =>
          proxyRequest(remote.baseUrl, `/agents/${agentName}/run`, req, res, remote.headers),
        );
        router.post(`/agents/${agentName}/stream`, (req: any, res: any) =>
          proxyRequest(remote.baseUrl, `/agents/${agentName}/stream`, req, res, remote.headers),
        );
      }
    }

    if (remote.teams) {
      for (const teamName of remote.teams) {
        router.post(`/teams/${teamName}/run`, (req: any, res: any) =>
          proxyRequest(remote.baseUrl, `/teams/${teamName}/run`, req, res, remote.headers),
        );
        router.post(`/teams/${teamName}/stream`, (req: any, res: any) =>
          proxyRequest(remote.baseUrl, `/teams/${teamName}/stream`, req, res, remote.headers),
        );
      }
    }

    if (remote.workflows) {
      for (const wfName of remote.workflows) {
        router.post(`/workflows/${wfName}/run`, (req: any, res: any) =>
          proxyRequest(remote.baseUrl, `/workflows/${wfName}/run`, req, res, remote.headers),
        );
      }
    }
  }

  router.get("/gateway/health", async (_req: any, res: any) => {
    const status: Record<string, boolean> = {};
    for (const remote of config.remotes) {
      const cached = remoteHealth.get(remote.baseUrl);
      status[remote.baseUrl] = cached ?? (await checkHealth(remote));
    }
    res.json({ remotes: status });
  });

  return router;
}
