import type { Agent, Registry, Servable, ServableAgent, Team, ToolDef, Toolkit } from "@agentium/core";

export interface GatewayResourceRequest {
  identity: Readonly<import("../express/types.js").HostedIdentity>;
  operation: "discover" | "execute" | "session:create" | "session:use" | "run:cancel";
  resource: { kind: "agent" | "team" | "workflow" | "tool" | "session" | "run"; id: string; target?: string };
}
export type GatewaySecurityOptions =
  | { mode: "local" }
  | {
      mode: "authenticated";
      /** Read only host-verified socket.data, never handshake payload claims. */
      resolveIdentity: (
        verifiedState: unknown,
      ) =>
        | import("../express/types.js").HostedIdentity
        | null
        | Promise<import("../express/types.js").HostedIdentity | null>;
      /** session:create must atomically bind the generated ID; deny unknown session:use. */
      authorizeResource: (request: GatewayResourceRequest) => boolean | Promise<boolean>;
    };

export interface GatewayOptions {
  security: GatewaySecurityOptions;
  /** Bounds apply per socket; outgoing frames use the Engine.IO drain contract. */
  textStream?: import("../text-stream.js").TextStreamLimits;
  maxConcurrentRuns?: number;
  /** Maximum collected final Agent text bytes. Default 256 KiB. */
  maxOutputBytes?: number;

  /**
   * Use a Registry for live auto-discovery. The gateway resolves agents/teams
   * at event time — any instance created after the gateway starts is automatically
   * reachable.
   *
   * When omitted, falls back to the global registry from `@agentium/core`.
   * Pass `false` to disable registry-based lookup (use explicit maps only).
   *
   * @example
   * createAgentGateway({ io, security: { mode: "local" } });
   * new Agent({ name: "bot", model: openai("gpt-4o") }); // immediately reachable
   */
  registry?: Registry | false;
  /**
   * Auto-discover agents and teams from a mixed array.
   * Each item is classified by its `.kind` and keyed by `.name`.
   */
  serve?: Servable[];
  agents?: Record<string, Agent | ServableAgent>;
  teams?: Record<string, Team>;
  io: any;
  namespace?: string;
  /** Must call next; thrown/rejected errors deny access. Returned promises settle before admission. */
  authMiddleware?: (socket: any, next: (err?: Error) => void) => void | Promise<void>;
  /** Max requests per minute per socket. Default: 60 */
  maxRequestsPerMinute?: number;
  /** Named tool library exposed via tools.list event. */
  toolLibrary?: Record<string, ToolDef>;
  /** Toolkit instances whose tools are exposed via tools.list. Merged with toolLibrary. */
  toolkits?: Toolkit[];
}
