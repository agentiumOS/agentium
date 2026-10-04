import { describe, expect, it } from "vitest";
import { safeParseSchema } from "../../tools/schema.js";
import { DaytonaSandboxToolkit } from "../sandbox-daytona.js";
import { E2BSandboxToolkit } from "../sandbox-e2b.js";

describe("optional sandbox toolkits", () => {
  it.each([E2BSandboxToolkit, DaytonaSandboxToolkit])("constructs without optional SDKs or external I/O", (Toolkit) => {
    const toolkit = new Toolkit();
    const prefix = toolkit.name.replaceAll("-", "_");
    expect(
      toolkit
        .getTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([`${prefix}_read_file`, `${prefix}_run`, `${prefix}_shell`, `${prefix}_write_file`]);
    expect(safeParseSchema(toolkit.getTools()[0].parameters, { code: "0", timeoutSeconds: -1 }).success).toBe(false);
  });
});
