import type { Agent, Registry, Servable, ServableAgent, Team, ToolDef, Toolkit } from "@agentium/core";

export interface GatewayOptions {
  /**
   * Use a Registry for live auto-discovery. The gateway resolves agents/teams
   * at event time — any instance created after the gateway starts is automatically
   * reachable.
   *
   * When omitted, falls back to the global registry from `@agentium/core`.
   * Pass `false` to disable registry-based lookup (use explicit maps only).
   *
   * @example
   * createAgentGateway({ io });
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
  authMiddleware?: (socket: any, next: (err?: Error) => void) => void;
  /** Max requests per minute per socket. Default: 60 */
  maxRequestsPerMinute?: number;
  /** Named tool library exposed via tools.list event. */
  toolLibrary?: Record<string, ToolDef>;
  /** Toolkit instances whose tools are exposed via tools.list. Merged with toolLibrary. */
  toolkits?: Toolkit[];
}
