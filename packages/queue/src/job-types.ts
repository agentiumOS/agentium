import type { RunOutput } from "@agentium/core";

export type AgentJobPayload = {
  type: "agent";
  agentName: string;
  input: string;
  sessionId?: string;
  userId?: string;
};

export type WorkflowJobPayload = {
  type: "workflow";
  workflowName: string;
  initialState?: Record<string, unknown>;
  sessionId?: string;
};

export type TeamJobPayload = {
  type: "team";
  teamName: string;
  input: string;
  sessionId?: string;
  userId?: string;
};

export type JobPayload = AgentJobPayload | WorkflowJobPayload | TeamJobPayload;

export type ScheduleInfo = {
  id: string;
  pattern: string;
  timezone?: string;
  next: Date;
};

export type JobStatus = {
  jobId: string;
  state: "waiting" | "active" | "completed" | "failed" | "delayed";
  progress?: number;
  result?: RunOutput;
  error?: string;
  createdAt: Date;
  processedAt?: Date;
  finishedAt?: Date;
};
