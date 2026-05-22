import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../agent/agent.js";
import { EventBus } from "../../events/event-bus.js";
import { AgentScheduler } from "../scheduler.js";

function mockAgent(name: string, eventBus?: EventBus): Agent {
  return {
    name,
    eventBus: eventBus ?? new EventBus(),
    async run(input: string) {
      return {
        text: `Result for: ${input}`,
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      };
    },
  } as any;
}

describe("AgentScheduler", () => {
  let scheduler: AgentScheduler;
  let eventBus: EventBus;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    scheduler = new AgentScheduler(eventBus);
  });

  afterEach(() => {
    scheduler.cancelAll();
    vi.useRealTimers();
  });

  describe("schedule()", () => {
    it("returns a schedule ID", () => {
      const agent = mockAgent("test-agent", eventBus);
      const id = scheduler.schedule(agent, {
        cron: "*/5 * * * *",
        input: "test",
      });
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });

    it("uses custom ID when provided", () => {
      const agent = mockAgent("test-agent", eventBus);
      const id = scheduler.schedule(agent, {
        id: "my-schedule",
        cron: "*/5 * * * *",
        input: "test",
      });
      expect(id).toBe("my-schedule");
    });

    it("fires schedule on interval", async () => {
      const agent = mockAgent("test-agent", eventBus);
      const fired = vi.fn();
      eventBus.on("schedule.fired" as any, fired);

      scheduler.schedule(agent, {
        cron: "*/5 * * * *",
        input: "test",
      });

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

      expect(fired).toHaveBeenCalled();
    });

    it("supports dynamic input function", () => {
      const agent = mockAgent("test-agent", eventBus);
      const inputFn = vi.fn().mockReturnValue("dynamic input");

      scheduler.schedule(agent, {
        cron: "*/5 * * * *",
        input: inputFn,
        contextContinuity: true,
      });

      const { schedules } = scheduler.list();
      expect(schedules).toHaveLength(1);
    });
  });

  describe("list()", () => {
    it("lists all schedules and triggers", () => {
      const agent = mockAgent("test-agent", eventBus);
      scheduler.schedule(agent, { cron: "*/5 * * * *", input: "test1" });
      scheduler.schedule(agent, { id: "s2", cron: "*/10 * * * *", input: "test2" });

      const { schedules, triggers } = scheduler.list();
      expect(schedules).toHaveLength(2);
      expect(triggers).toHaveLength(0);
    });

    it("includes schedule metadata", () => {
      const agent = mockAgent("agent-1", eventBus);
      scheduler.schedule(agent, {
        id: "my-sched",
        cron: "*/5 * * * *",
        input: "test",
      });

      const { schedules } = scheduler.list();
      expect(schedules[0].id).toBe("my-sched");
      expect(schedules[0].agentName).toBe("agent-1");
      expect(schedules[0].enabled).toBe(true);
      expect(schedules[0].runCount).toBe(0);
    });
  });

  describe("pause() and resume()", () => {
    it("pauses a schedule", () => {
      const agent = mockAgent("agent", eventBus);
      const id = scheduler.schedule(agent, { cron: "*/5 * * * *", input: "t" });

      scheduler.pause(id);
      const { schedules } = scheduler.list();
      expect(schedules[0].enabled).toBe(false);
    });

    it("resumes a paused schedule", () => {
      const agent = mockAgent("agent", eventBus);
      const id = scheduler.schedule(agent, { cron: "*/5 * * * *", input: "t" });

      scheduler.pause(id);
      scheduler.resume(id);
      const { schedules } = scheduler.list();
      expect(schedules[0].enabled).toBe(true);
    });
  });

  describe("cancel()", () => {
    it("removes a schedule", () => {
      const agent = mockAgent("agent", eventBus);
      const id = scheduler.schedule(agent, { cron: "*/5 * * * *", input: "t" });

      scheduler.cancel(id);
      const { schedules } = scheduler.list();
      expect(schedules).toHaveLength(0);
    });
  });

  describe("cancelAll()", () => {
    it("removes all schedules and triggers", () => {
      const agent = mockAgent("agent", eventBus);
      scheduler.schedule(agent, { cron: "*/5 * * * *", input: "t1" });
      scheduler.schedule(agent, { cron: "*/10 * * * *", input: "t2" });

      scheduler.cancelAll();
      const { schedules, triggers } = scheduler.list();
      expect(schedules).toHaveLength(0);
      expect(triggers).toHaveLength(0);
    });
  });

  describe("trigger()", () => {
    it("creates an event trigger", () => {
      const agent = mockAgent("agent", eventBus);
      const id = scheduler.trigger(agent, {
        event: "run.error",
        input: "investigate error",
      });

      expect(id).toBeTruthy();
      const { triggers } = scheduler.list();
      expect(triggers).toHaveLength(1);
      expect(triggers[0].event).toBe("run.error");
    });

    it("throws without eventBus", () => {
      const noEventScheduler = new AgentScheduler();
      const agent = mockAgent("agent");

      expect(() => noEventScheduler.trigger(agent, { event: "test", input: "x" })).toThrow("EventBus");
    });

    it("fires agent run on matching event", async () => {
      const agent = mockAgent("agent", eventBus);
      const runSpy = vi.spyOn(agent, "run" as any);

      scheduler.trigger(agent, {
        event: "run.error",
        input: (data: any) => `Error: ${data.error.message}`,
      });

      eventBus.emit("run.error", { runId: "r1", error: new Error("test") });
      await vi.runAllTimersAsync();

      expect(runSpy).toHaveBeenCalled();
    });

    it("respects filter function", async () => {
      const agent = mockAgent("agent", eventBus);
      const runSpy = vi.spyOn(agent, "run" as any);

      scheduler.trigger(agent, {
        event: "run.error",
        filter: (data: any) => data.error.message.includes("critical"),
        input: "investigate",
      });

      eventBus.emit("run.error", { runId: "r1", error: new Error("minor issue") });
      await vi.runAllTimersAsync();
      expect(runSpy).not.toHaveBeenCalled();

      eventBus.emit("run.error", { runId: "r2", error: new Error("critical failure") });
      await vi.runAllTimersAsync();
      expect(runSpy).toHaveBeenCalled();
    });
  });
});
