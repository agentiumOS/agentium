export interface RbacConfig {
  scopeField?: string;
  /** Override an exact route pattern. Empty scopes explicitly permit authenticated access. */
  defaultScopes?: Record<string, string[]>;
  agentScopes?: Record<string, string[]>;
  /** Explicit routes accessible without authentication. Use only for intentionally public endpoints. */
  publicRoutes?: string[];
}

const DEFAULT_SCOPE_MAP: Record<string, string[]> = {
  "POST /agents/:name/run": ["agents:run"],
  "POST /agents/:name/stream": ["agents:run"],
  "POST /agents/:name/corrections": ["corrections:write"],
  "GET /agents/:name/checkpoints": ["checkpoints:read"],
  "POST /agents/:name/rollback/:checkpointId": ["checkpoints:restore"],
  "GET /agents/:name/card": ["agents:read"],
  "GET /agents": ["agents:read"],
  "POST /teams/:name/run": ["teams:run"],
  "POST /teams/:name/stream": ["teams:run"],
  "GET /teams": ["teams:read"],
  "POST /workflows/:name/run": ["workflows:run"],
  "GET /workflows": ["workflows:read"],
  "GET /registry": ["agents:read", "teams:read", "workflows:read"],
  "GET /.well-known/agent-cards.json": ["agents:read"],
  "GET /approvals/pending": ["approvals:read"],
  "GET /approvals/stream": ["approvals:read"],
  "POST /approvals/:requestId/approve": ["approvals:write"],
  "POST /approvals/:requestId/deny": ["approvals:write"],
  "GET /schedules": ["schedules:read"],
  "POST /schedules": ["schedules:write"],
  "DELETE /schedules/:id": ["schedules:write"],
  "GET /metrics": ["metrics:read"],
  "GET /metrics/:format": ["metrics:read"],
  "GET /tools": ["tools:read"],
  "GET /tools/:name": ["tools:read"],
  "GET /admin/**": ["admin:*"],
  "POST /admin/**": ["admin:*"],
  "PUT /admin/**": ["admin:*"],
  "PATCH /admin/**": ["admin:*"],
  "DELETE /admin/**": ["admin:*"],
};

export function routeMatches(actual: string, pattern: string): boolean {
  const actualParts = actual.split(/[\s/]+/).filter(Boolean);
  const patternParts = pattern.split(/[\s/]+/).filter(Boolean);
  const wildcard = patternParts.at(-1) === "**";
  if (wildcard) patternParts.pop();
  if (wildcard ? actualParts.length < patternParts.length : actualParts.length !== patternParts.length) return false;
  return patternParts.every((part, i) => part.startsWith(":") || part === actualParts[i]);
}

export function createRbacMiddleware(config: RbacConfig = {}) {
  const scopeField = config.scopeField ?? "scopes";
  const scopeMap = { ...(config.defaultScopes ?? {}), ...DEFAULT_SCOPE_MAP, ...(config.defaultScopes ?? {}) };
  return (req: any, res: any, next: any) => {
    const routeKey = `${req.method} ${req.path}`;
    if (config.publicRoutes?.some((pattern) => routeMatches(routeKey, pattern))) return next();
    const user = req.user;
    if (!user) return res.status(401).json({ error: "Authentication required" });
    const value = user[scopeField] ?? user.scope;
    const userScopes: string[] = Array.isArray(value)
      ? value.filter((scope: unknown): scope is string => typeof scope === "string")
      : typeof value === "string"
        ? value.split(/\s+/)
        : [];
    const match = Object.entries(scopeMap).find(([pattern]) => routeMatches(routeKey, pattern));
    // Even administrators must explicitly configure newly introduced routes.
    if (!match) return res.status(403).json({ error: "Route has no authorization configuration" });
    const agentName = /^\/agents\/([^/]+)/.exec(req.path)?.[1];
    const required = [...match[1], ...(agentName ? (config.agentScopes?.[decodeURIComponent(agentName)] ?? []) : [])];
    if (
      !userScopes.includes("admin:*") &&
      !userScopes.includes("*") &&
      !required.every((scope) => userScopes.includes(scope))
    ) {
      return res.status(403).json({ error: "Insufficient permissions", required, provided: userScopes });
    }
    next();
  };
}
