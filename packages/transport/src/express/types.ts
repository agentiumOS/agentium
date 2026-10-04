import type { Agent, Registry, Servable, ServableAgent, Team, ToolDef, Toolkit, Workflow } from "@agentium/core";
import type { FileUploadOptions } from "./file-upload.js";
import type { MCPManager } from "./mcp-manager.js";

export interface SwaggerOptions {
  /** Enable Swagger UI at /docs. Default: false */
  enabled?: boolean;
  /** API title shown in Swagger UI */
  title?: string;
  /** API description shown in Swagger UI */
  description?: string;
  /** API version string */
  version?: string;
  /** Route prefix used in path generation (e.g. "/api") */
  routePrefix?: string;
  /** Server URLs for the spec */
  servers?: Array<{ url: string; description?: string }>;
  /** Path to serve Swagger UI. Default: "/docs" */
  docsPath?: string;
  /** Path to serve the raw OpenAPI JSON spec. Default: "/docs/spec.json" */
  specPath?: string;
}

/** Identity derived only from credentials verified by host middleware or JWT. */
export interface HostedIdentity {
  userId: string;
  tenantId?: string;
}

export interface HostedResourceRequest {
  identity: Readonly<HostedIdentity>;
  operation: string;
  resource: {
    kind: "session" | "run" | "approval" | "checkpoint" | "correction" | "schedule" | "admin";
    id?: string;
    agentName?: string;
    /** Requested correction visibility, for host policy evaluation. */
    scope?: string;
  };
}

export type HostedSecurityOptions =
  | { mode: "local" }
  | {
      mode: "authenticated";
      /** Receives req.user after trusted middleware/JWT verification; never the request body. */
      resolveIdentity: (verifiedClaims: unknown) => HostedIdentity | null | Promise<HostedIdentity | null>;
      /**
       * Check authoritative owner records. Unknown/ownerless records MUST return false.
       * session:create MUST atomically bind this new opaque ID to identity before returning true.
       * Collection operations grant access to the entire collection; deny when that is inappropriate.
       * Scopes (including admin:*) never bypass this authorization.
       */
      authorizeResource: (request: HostedResourceRequest) => boolean | Promise<boolean>;
    };

export interface RouterOptions {
  /** Required explicit boundary. JWT/RBAC require authenticated mode and both host hooks. */
  security: HostedSecurityOptions;
  /**
   * Use a Registry for live auto-discovery. The router creates dynamic routes
   * that resolve agents/teams/workflows at request time — any instance created
   * after the router is mounted is automatically available.
   *
   * When omitted, falls back to the global registry from `@agentium/core`.
   * Pass `false` to disable registry-based routing entirely (use explicit maps only).
   *
   * @example
   * createAgentRouter({ security: { mode: "local" }, cors: true });
   * new Agent({ name: "bot", model: openai("gpt-4o") }); // immediately routable
   */
  registry?: Registry | false;
  /**
   * Auto-discover agents, teams, and workflows from a mixed array.
   * Each item is classified by its `.kind` and keyed by `.name`.
   */
  serve?: Servable[];
  agents?: Record<string, Agent | ServableAgent>;
  teams?: Record<string, Team>;
  workflows?: Record<string, Workflow<any>>;
  middleware?: any[];
  /** Swagger / OpenAPI configuration */
  swagger?: SwaggerOptions;
  /** Connection-owned text response limits. */
  textStream?: import("../text-stream.js").TextStreamLimits;
  /** File upload configuration for multi-modal inputs */
  fileUpload?: boolean | FileUploadOptions;
  /** CORS configuration. Pass true or '*' for permissive, a string for a single origin, or an array for multiple origins. */
  cors?: string | string[] | boolean;
  /** Rate limiting configuration. Pass true for defaults (100 req/min), or an object to customize. */
  rateLimit?: { windowMs?: number; max?: number } | boolean;
  /** Named tool library exposed via GET /tools. Tools from toolkits are auto-collected. */
  toolLibrary?: Record<string, ToolDef>;
  /** Toolkit instances whose tools are exposed via GET /tools. Merged with toolLibrary. */
  toolkits?: Toolkit[];
  /**
   * Enable admin routes under `/admin` for managing MCP servers and the toolkit catalog.
   * Pass `true` to use defaults, or provide an MCPManager instance to share state.
   */
  admin?: boolean | { mcpManager?: MCPManager; middleware?: any[] };
  /**
   * Enable schedule management routes under `/schedules`.
   * Pass an AgentQueue instance from `@agentium/queue`.
   */
  scheduler?: any;
  /**
   * MetricsExporter instance from `@agentium/observability` for `/metrics` endpoints.
   */
  metricsExporter?: any;
  /**
   * JWT authentication middleware. Verifies tokens and attaches decoded payload to `req.user`.
   * Requires `jsonwebtoken` package.
   */
  jwt?: import("./jwt-middleware.js").JwtConfig;
  /**
   * Role-based access control. Checks `req.user.scopes` against required scopes per route.
   * Requires `jwt` to be configured first.
   */
  rbac?: import("./rbac-middleware.js").RbacConfig;
}
