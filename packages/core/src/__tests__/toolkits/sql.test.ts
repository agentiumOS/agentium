import { describe, expect, it } from "vitest";
import { SqlToolkit } from "../../toolkits/sql.js";

describe("SqlToolkit", () => {
  it("returns three tools", () => {
    const tk = new SqlToolkit({ dialect: "sqlite", connectionString: ":memory:" });
    const tools = tk.getTools();
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["sql_query", "sql_tables", "sql_describe"]);
  });

  it("sql_query description mentions dialect", () => {
    const tk = new SqlToolkit({ dialect: "postgres", connectionString: "postgres://localhost/test" });
    const tool = tk.getTools().find((t) => t.name === "sql_query")!;
    expect(tool.description).toContain("postgres");
  });

  it("validates read-only mode blocks INSERT", async () => {
    const tk = new SqlToolkit({ dialect: "sqlite", connectionString: ":memory:", readOnly: true });
    const tool = tk.getTools().find((t) => t.name === "sql_query")!;
    await expect(tool.execute({ query: "INSERT INTO t VALUES (1)" }, {} as any)).rejects.toThrow("Read-only");
  });

  it("validates read-only mode blocks DROP", async () => {
    const tk = new SqlToolkit({ dialect: "sqlite", connectionString: ":memory:", readOnly: true });
    const tool = tk.getTools().find((t) => t.name === "sql_query")!;
    await expect(tool.execute({ query: "DROP TABLE users" }, {} as any)).rejects.toThrow("Read-only");
  });

  it("allows SELECT in read-only mode validation", async () => {
    const tk = new SqlToolkit({ dialect: "sqlite", connectionString: ":memory:", readOnly: true });
    const tool = tk.getTools().find((t) => t.name === "sql_query")!;
    // Will fail at connection level (no better-sqlite3 in test env) but not at validation
    await expect(tool.execute({ query: "SELECT 1" }, {} as any)).rejects.not.toThrow("Read-only");
  });

  it("sql_describe validates table name", async () => {
    const tk = new SqlToolkit({ dialect: "sqlite", connectionString: ":memory:" });
    const tool = tk.getTools().find((t) => t.name === "sql_describe")!;
    await expect(tool.execute({ table: "Robert'; DROP TABLE--" }, {} as any)).rejects.toThrow("Invalid table name");
  });
});
