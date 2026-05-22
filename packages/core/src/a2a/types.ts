/**
 * A2A (Agent-to-Agent) Protocol types.
 * Based on the A2A specification v0.2.
 * https://google.github.io/A2A/specification/
 */

// ── Parts ─────────────────────────────────────────────────────────────────

export interface A2ATextPart {
  kind: "text";
  text: string;
}

export interface A2AFilePart {
  kind: "file";
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string;
    uri?: string;
  };
}

export interface A2ADataPart {
  kind: "data";
  data: Record<string, unknown>;
}

export type A2APart = A2ATextPart | A2AFilePart | A2ADataPart;

// ── Messages ──────────────────────────────────────────────────────────────

export interface A2AMessage {
  role: "user" | "agent";
  parts: A2APart[];
  messageId?: string;
  taskId?: string;
  referenceTaskIds?: string[];
  metadata?: Record<string, unknown>;
}

// ── Task ──────────────────────────────────────────────────────────────────

export type A2ATaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  sessionId?: string;
  status: {
    state: A2ATaskState;
    message?: A2AMessage;
    timestamp?: string;
  };
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

// ── Agent Card ────────────────────────────────────────────────────────────

export interface A2ASkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

export interface A2AAgentCard {
  name: string;
  description?: string;
  url: string;
  version?: string;
  provider?: {
    organization: string;
    url?: string;
  };
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  authentication?: {
    schemes?: string[];
    credentials?: string;
  };
  skills?: A2ASkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  supportedInputModes?: string[];
  supportedOutputModes?: string[];
}

// ── JSON-RPC ──────────────────────────────────────────────────────────────

export interface A2AJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface A2AJsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ── Send/Stream params ────────────────────────────────────────────────────

export interface A2ASendParams {
  message: A2AMessage;
  configuration?: {
    acceptedOutputModes?: string[];
    blocking?: boolean;
  };
  metadata?: Record<string, unknown>;
}

export interface A2ATaskQueryParams {
  id: string;
  historyLength?: number;
}
