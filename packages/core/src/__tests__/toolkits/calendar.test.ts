import { describe, expect, it } from "vitest";
import { GoogleCalendarToolkit } from "../../toolkits/calendar.js";

describe("GoogleCalendarToolkit", () => {
  it("returns four tools", () => {
    const mockAuth = { credentials: {} };
    const tk = new GoogleCalendarToolkit({ authClient: mockAuth });
    const tools = tk.getTools();
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual([
      "calendar_list_events",
      "calendar_create_event",
      "calendar_get_event",
      "calendar_delete_event",
    ]);
  });

  it("has correct parameter schemas", () => {
    const tk = new GoogleCalendarToolkit({ authClient: {} });
    const tools = tk.getTools();

    const createTool = tools.find((t) => t.name === "calendar_create_event")!;
    const shape = createTool.parameters.shape;
    expect(shape).toHaveProperty("summary");
    expect(shape).toHaveProperty("startTime");
    expect(shape).toHaveProperty("endTime");
  });

  it("throws without credentials", async () => {
    const tk = new GoogleCalendarToolkit();
    const tool = tk.getTools()[0];
    await expect(tool.execute({}, {} as any)).rejects.toThrow("credentialsPath");
  });
});
