import { v4 as uuidv4 } from "uuid";
import type { Agent } from "../agent/agent.js";
import type { RunOutput } from "../agent/types.js";
import type { EventBus } from "../events/event-bus.js";
import type { ScheduleConfig, ScheduleInfo, TriggerConfig, TriggerInfo } from "./types.js";

interface ScheduleEntry {
  id: string;
  agent: Agent;
  config: ScheduleConfig;
  timer: ReturnType<typeof setInterval> | null;
  cronTask: any;
  lastResult?: RunOutput;
  lastRunAt?: Date;
  runCount: number;
  errorCount: number;
  enabled: boolean;
}

interface TriggerEntry {
  id: string;
  agent: Agent;
  config: TriggerConfig;
  enabled: boolean;
  triggerCount: number;
  debounceTimer?: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
}

function parseCronToMs(cron: string): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return null;

  if (parts[0].startsWith("*/")) {
    const mins = parseInt(parts[0].slice(2), 10);
    if (!Number.isNaN(mins) && parts.slice(1).every((p) => p === "*")) return mins * 60_000;
  }

  return null;
}

export class AgentScheduler {
  private schedules = new Map<string, ScheduleEntry>();
  private triggers = new Map<string, TriggerEntry>();
  private eventBus?: EventBus;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus;
  }

  schedule(agent: Agent, config: ScheduleConfig): string {
    const id = config.id ?? uuidv4();

    const entry: ScheduleEntry = {
      id,
      agent,
      config,
      timer: null,
      cronTask: null,
      runCount: 0,
      errorCount: 0,
      enabled: config.enabled !== false,
    };

    if (entry.enabled) {
      this.startSchedule(entry);
    }

    this.schedules.set(id, entry);
    return id;
  }

  private startSchedule(entry: ScheduleEntry): void {
    const intervalMs = parseCronToMs(entry.config.cron);

    if (intervalMs) {
      entry.timer = setInterval(() => this.executeSchedule(entry), intervalMs);
    } else {
      try {
        const nodeCron = require("node-cron");
        const opts: any = {};
        if (entry.config.timezone) opts.timezone = entry.config.timezone;

        entry.cronTask = nodeCron.schedule(entry.config.cron, () => this.executeSchedule(entry), opts);
      } catch {
        const fallbackMs = 60_000;
        console.warn(
          `[AgentScheduler] node-cron not available, falling back to ${fallbackMs}ms interval for "${entry.id}"`,
        );
        entry.timer = setInterval(() => this.executeSchedule(entry), fallbackMs);
      }
    }
  }

  private async executeSchedule(entry: ScheduleEntry): Promise<void> {
    const input =
      typeof entry.config.input === "function"
        ? entry.config.input(entry.config.contextContinuity ? entry.lastResult : undefined)
        : entry.config.input;

    this.eventBus?.emit("schedule.fired" as any, { scheduleId: entry.id, agentName: entry.agent.name });

    let retries = 0;
    const maxRetries = entry.config.maxRetries ?? 0;

    while (retries <= maxRetries) {
      try {
        const result = await entry.agent.run(input, entry.config.runOpts);
        entry.lastResult = result;
        entry.lastRunAt = new Date();
        entry.runCount++;
        this.eventBus?.emit("schedule.completed" as any, {
          scheduleId: entry.id,
          agentName: entry.agent.name,
          runCount: entry.runCount,
        });
        return;
      } catch (error) {
        retries++;
        if (retries > maxRetries) {
          entry.errorCount++;
          entry.lastRunAt = new Date();
          this.eventBus?.emit("schedule.error" as any, {
            scheduleId: entry.id,
            agentName: entry.agent.name,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        } else {
          await new Promise((r) => setTimeout(r, 1000 * retries));
        }
      }
    }
  }

  trigger(agent: Agent, config: TriggerConfig): string {
    if (!this.eventBus) throw new Error("AgentScheduler requires an EventBus for triggers");

    const id = uuidv4();

    const entry: TriggerEntry = {
      id,
      agent,
      config,
      enabled: true,
      triggerCount: 0,
    };

    const handler = (data: any) => {
      if (!entry.enabled) return;
      if (config.filter && !config.filter(data)) return;

      if (config.debounceMs) {
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        entry.debounceTimer = setTimeout(() => this.executeTrigger(entry, data), config.debounceMs);
      } else {
        this.executeTrigger(entry, data);
      }
    };

    this.eventBus.on(config.event as any, handler);
    entry.cleanup = () => this.eventBus?.off(config.event as any, handler);

    this.triggers.set(id, entry);
    return id;
  }

  private async executeTrigger(entry: TriggerEntry, eventData: any): Promise<void> {
    const input = typeof entry.config.input === "function" ? entry.config.input(eventData) : entry.config.input;

    this.eventBus?.emit("trigger.fired" as any, {
      triggerId: entry.id,
      agentName: entry.agent.name,
      event: entry.config.event,
    });
    entry.triggerCount++;

    try {
      await entry.agent.run(input, entry.config.runOpts);
    } catch (error) {
      console.error(`[AgentScheduler] Trigger ${entry.id} failed:`, error);
    }
  }

  pause(id: string): void {
    const schedule = this.schedules.get(id);
    if (schedule) {
      schedule.enabled = false;
      if (schedule.timer) clearInterval(schedule.timer);
      if (schedule.cronTask?.stop) schedule.cronTask.stop();
      schedule.timer = null;
      schedule.cronTask = null;
      return;
    }

    const trigger = this.triggers.get(id);
    if (trigger) {
      trigger.enabled = false;
    }
  }

  resume(id: string): void {
    const schedule = this.schedules.get(id);
    if (schedule && !schedule.enabled) {
      schedule.enabled = true;
      this.startSchedule(schedule);
      return;
    }

    const trigger = this.triggers.get(id);
    if (trigger) {
      trigger.enabled = true;
    }
  }

  cancel(id: string): void {
    const schedule = this.schedules.get(id);
    if (schedule) {
      if (schedule.timer) clearInterval(schedule.timer);
      if (schedule.cronTask?.stop) schedule.cronTask.stop();
      this.schedules.delete(id);
      return;
    }

    const trigger = this.triggers.get(id);
    if (trigger) {
      trigger.cleanup?.();
      if (trigger.debounceTimer) clearTimeout(trigger.debounceTimer);
      this.triggers.delete(id);
    }
  }

  list(): { schedules: ScheduleInfo[]; triggers: TriggerInfo[] } {
    const schedules: ScheduleInfo[] = [...this.schedules.values()].map((e) => ({
      id: e.id,
      agentName: e.agent.name,
      cron: e.config.cron,
      timezone: e.config.timezone,
      enabled: e.enabled,
      lastRunAt: e.lastRunAt,
      lastResult: e.lastResult,
      runCount: e.runCount,
      errorCount: e.errorCount,
    }));

    const triggers: TriggerInfo[] = [...this.triggers.values()].map((e) => ({
      id: e.id,
      agentName: e.agent.name,
      event: e.config.event,
      enabled: e.enabled,
      triggerCount: e.triggerCount,
    }));

    return { schedules, triggers };
  }

  cancelAll(): void {
    for (const id of this.schedules.keys()) this.cancel(id);
    for (const id of this.triggers.keys()) this.cancel(id);
  }
}
