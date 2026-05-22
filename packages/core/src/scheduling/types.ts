import type { RunOpts, RunOutput } from "../agent/types.js";

export interface ScheduleConfig {
  id?: string;
  cron: string;
  timezone?: string;
  input: string | ((lastResult?: RunOutput) => string);
  runOpts?: Partial<RunOpts>;
  contextContinuity?: boolean;
  maxRetries?: number;
  enabled?: boolean;
}

export interface TriggerConfig {
  event: string;
  filter?: (data: any) => boolean;
  input: string | ((eventData: any) => string);
  runOpts?: Partial<RunOpts>;
  debounceMs?: number;
}

export interface ScheduleInfo {
  id: string;
  agentName: string;
  cron: string;
  timezone?: string;
  enabled: boolean;
  lastRunAt?: Date;
  lastResult?: RunOutput;
  nextRunAt?: Date;
  runCount: number;
  errorCount: number;
}

export interface TriggerInfo {
  id: string;
  agentName: string;
  event: string;
  enabled: boolean;
  triggerCount: number;
}
