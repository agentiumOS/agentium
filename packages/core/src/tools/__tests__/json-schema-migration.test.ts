import { describe, expect, it } from "vitest";
import { z as z3 } from "zod/v3";
import { z as z4 } from "zod/v4";
import { convertJsonSchema } from "../json-schema.js";

describe("schema migration boundary", () => {
  const fixtures = [
    {
      version: "zod3",
      source: z3
        .object({
          kind: z3.union([z3.literal("read"), z3.literal("write")]),
          query: z3.string().min(2).describe("Search query"),
          count: z3.number().int().min(1).optional(),
          nested: z3.object({ active: z3.boolean() }).strict(),
        })
        .strict(),
      transformed: z3.object({
        slug: z3
          .string()
          .transform((input) => input.trim())
          .refine((input) => input !== "blocked"),
      }),
    },
    {
      version: "zod4",
      source: z4
        .object({
          kind: z4.union([z4.literal("read"), z4.literal("write")]),
          query: z4.string().min(2).describe("Search query"),
          count: z4.number().int().min(1).optional(),
          nested: z4.object({ active: z4.boolean() }).strict(),
        })
        .strict(),
      transformed: z4.object({
        slug: z4
          .string()
          .transform((input) => input.trim())
          .refine((input) => input !== "blocked"),
      }),
    },
  ] as const;
  for (const { version, source, transformed } of fixtures) {
    it(`${version}: preserves nested unions, optionals, descriptions, bounds and strictness`, () => {
      const result = convertJsonSchema(source);
      expect(result.dialect).toBe(version);
      expect(result.schema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["kind", "query", "nested"],
        properties: {
          query: { description: "Search query", minLength: 2 },
          count: { type: "integer", minimum: 1 },
          nested: { additionalProperties: false },
        },
      });
      expect(result.schema).not.toHaveProperty("$schema");
      expect(result.diagnostics).toEqual([]);
      expect(source.safeParse({ kind: "read", query: "ok", nested: { active: true }, extra: true }).success).toBe(
        false,
      );
    });
    it(`${version}: reports runtime transformations and custom refinements`, () => {
      const source = transformed;
      const result = convertJsonSchema(source);
      expect(result.schema).toMatchObject({ properties: { slug: { type: "string" } } });
      expect(result.diagnostics.some((item) => item.kind === "transform")).toBe(true);
      expect(result.diagnostics.some((item) => item.kind === "refinement")).toBe(true);
      expect(source.parse({ slug: " okay " }).slug).toBe("okay");
      expect(source.safeParse({ slug: " blocked " }).success).toBe(false);
    });
  }
  it("native v4 rejects unrepresentable schemas instead of producing an unconstrained schema", () => {
    expect(() => convertJsonSchema(z4.object({ value: z4.symbol() }))).toThrow();
  });
});
