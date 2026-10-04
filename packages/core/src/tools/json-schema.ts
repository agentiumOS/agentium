import { createRequire } from "node:module";
import type { AgentiumSchema } from "./schema.js";

const requireSchema = createRequire(import.meta.url);
export interface SchemaConversionDiagnostic {
  path: string;
  kind: "transform" | "refinement";
  message: string;
}

/** Public dual-version schema conversion boundary.
 * Zod 4 schemas use native conversion; Zod 3 keeps its compatible converter.
 * JSON Schema describes input shape, not arbitrary executable checks. */
export function convertJsonSchema(schema: AgentiumSchema): {
  schema: Record<string, unknown>;
  diagnostics: SchemaConversionDiagnostic[];
  dialect: "zod3" | "zod4";
} {
  const diagnostics: SchemaConversionDiagnostic[] = [];
  const seen = new WeakSet<object>();
  const inspect = (value: any, path: string): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const def = value._zod?.def ?? value._def;
    if (def) {
      const effect = def.effect?.type ?? def.type;
      if (effect === "transform" || effect === "preprocess" || effect === "refinement" || effect === "custom") {
        const kind = effect === "refinement" || effect === "custom" ? "refinement" : "transform";
        diagnostics.push({
          path,
          kind,
          message: `${kind === "transform" ? "Transformation" : "Custom validation"} remains runtime-only; JSON Schema represents the input shape`,
        });
      }
      if (def.shape) {
        const shape = typeof def.shape === "function" ? def.shape() : def.shape;
        for (const [key, child] of Object.entries(shape)) inspect(child, `${path}/${key}`);
      }
      for (const [key, child] of Object.entries(def)) {
        if (key === "shape") continue;
        if (Array.isArray(child))
          child.forEach((entry, index) => {
            inspect(entry, `${path}/${key}/${index}`);
          });
        else inspect(child, path);
      }
    }
  };
  inspect(schema, "");
  const native = "_zod" in schema;
  const result: Record<string, unknown> = native
    ? requireSchema("zod/v4").toJSONSchema(schema, {
        target: "draft-7",
        io: "input",
        unrepresentable: "throw",
        cycles: "throw",
        override: ({ zodSchema, jsonSchema }: any) => {
          // An ESM schema may carry metadata in a different module registry from
          // this synchronous CJS converter. Read its own accessor to retain it.
          if (typeof zodSchema.meta === "function") Object.assign(jsonSchema, zodSchema.meta() ?? {});
          else if (typeof zodSchema.description === "string") jsonSchema.description = zodSchema.description;
        },
      })
    : requireSchema("zod-to-json-schema").zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" });
  delete result.$schema;
  return { schema: result, diagnostics, dialect: native ? "zod4" : "zod3" };
}
