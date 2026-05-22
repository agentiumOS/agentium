export interface RbacConfig {
  scopeField?: string;
  defaultScopes?: Record<string, string[]>;
  agentScopes?: Record<string, string[]>;
}

const DEFAULT_SCOPE_MAP: Record<string, string[]> = {
  "POST /agents/:name/run": ["agents:run"],
  "POST /agents/:name/stream": ["agents:run"],
  "GET /agents": ["agents:read"],
  "POST /teams/:name/run": ["teams:run"],
  "POST /teams/:name/stream": ["teams:run"],
  "GET /teams": ["teams:read"],
  "POST /workflows/:name/run": ["workflows:run"],
  "GET /workflows": ["workflows:read"],
  "GET /admin": ["admin:*"],
  "POST /admin": ["admin:*"],
  "DELETE /admin": ["admin:*"],
};

function normalizeRoute(method: string, path: string): string {
  const normalized = path.replace(/\/[a-zA-Z0-9_-]+(?=\/(?:run|stream|card|checkpoints))/g, "/:name");
  return `${method} ${normalized}`;
}

export function createRbacMiddleware(config: RbacConfig = {}) {
  const scopeField = config.scopeField ?? "scopes";
  const scopeMap = { ...DEFAULT_SCOPE_MAP, ...(config.defaultScopes ?? {}) };

  return (req: any, res: any, next: any) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const userScopes: string[] = user[scopeField] ?? user.scope?.split(" ") ?? [];

    if (userScopes.includes("admin:*") || userScopes.includes("*")) {
      return next();
    }

    const routeKey = normalizeRoute(req.method, req.path);
    let requiredScopes: string[] = [];

    for (const [pattern, scopes] of Object.entries(scopeMap)) {
      if (routeKey === pattern || routeMatches(routeKey, pattern)) {
        requiredScopes = scopes;
        break;
      }
    }

    if (config.agentScopes && req.params?.name) {
      const agentSpecific = config.agentScopes[req.params.name];
      if (agentSpecific) {
        requiredScopes = [...requiredScopes, ...agentSpecific];
      }
    }

    if (requiredScopes.length === 0) {
      return next();
    }

    const hasRequired = requiredScopes.every((scope) => userScopes.includes(scope));
    if (!hasRequired) {
      return res.status(403).json({
        error: "Insufficient permissions",
        required: requiredScopes,
        provided: userScopes,
      });
    }

    next();
  };
}

function routeMatches(actual: string, pattern: string): boolean {
  const actualParts = actual.split(/[\s/]+/).filter(Boolean);
  const patternParts = pattern.split(/[\s/]+/).filter(Boolean);
  if (actualParts.length !== patternParts.length) return false;
  return patternParts.every((part, i) => part.startsWith(":") || part === actualParts[i]);
}
