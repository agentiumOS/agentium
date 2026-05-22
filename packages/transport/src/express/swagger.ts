import { createRequire } from "node:module";
import type { RouterOptions, SwaggerOptions } from "./types.js";

const _require = createRequire(import.meta.url);

function zodSchemaToJsonSchema(schema: any): Record<string, unknown> | null {
  try {
    const zodToJsonSchema = _require("zod-to-json-schema").default ?? _require("zod-to-json-schema");
    const result = zodToJsonSchema(schema, { target: "openApi3" });
    const { $schema, ...rest } = result as Record<string, unknown>;
    return rest;
  } catch {
    return null;
  }
}

interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    description: string;
    version: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  security?: Array<Record<string, string[]>>;
  tags: Array<{ name: string; description: string }>;
}

const SCHEMAS = {
  RunRequest: {
    type: "object",
    required: ["input"],
    properties: {
      input: {
        oneOf: [
          { type: "string", description: "Text input" },
          {
            type: "array",
            description: "Multi-modal content parts",
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["text"] },
                    text: { type: "string" },
                  },
                  required: ["type", "text"],
                },
                {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["image"] },
                    data: { type: "string", description: "Base64 data or URL" },
                    mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/gif", "image/webp"] },
                  },
                  required: ["type", "data"],
                },
                {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["audio"] },
                    data: { type: "string", description: "Base64 data or URL" },
                    mimeType: { type: "string" },
                  },
                  required: ["type", "data"],
                },
                {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["file"] },
                    data: { type: "string", description: "Base64 data or URL" },
                    mimeType: { type: "string" },
                    fileName: { type: "string" },
                  },
                  required: ["type", "data"],
                },
              ],
            },
          },
        ],
      },
      sessionId: { type: "string", description: "Session ID for conversation continuity" },
      userId: { type: "string", description: "User identifier" },
    },
  },
  MultipartRunRequest: {
    type: "object",
    properties: {
      input: { type: "string", description: "Text input" },
      sessionId: { type: "string" },
      userId: { type: "string" },
      files: {
        type: "array",
        items: { type: "string", format: "binary" },
        description: "Files to include as multi-modal input (images, audio, documents)",
      },
    },
    required: ["input"],
  },
  RunOutput: {
    type: "object",
    properties: {
      text: { type: "string", description: "Agent response text" },
      toolCalls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            toolCallId: { type: "string" },
            toolName: { type: "string" },
            result: {},
          },
        },
      },
      usage: {
        type: "object",
        properties: {
          promptTokens: { type: "number" },
          completionTokens: { type: "number" },
          totalTokens: { type: "number" },
          reasoningTokens: { type: "number", description: "Tokens used for chain-of-thought reasoning" },
          cachedTokens: { type: "number", description: "Prompt tokens served from cache" },
          audioInputTokens: { type: "number", description: "Audio input tokens" },
          audioOutputTokens: { type: "number", description: "Audio output tokens" },
          providerMetrics: { type: "object", description: "Raw usage metrics from the underlying provider API" },
        },
      },
      structured: { description: "Parsed structured output (if schema is configured)" },
      durationMs: { type: "number" },
    },
  },
  StreamChunk: {
    type: "object",
    description: "Server-Sent Event data",
    properties: {
      type: { type: "string", enum: ["text", "tool_call_start", "tool_call_delta", "tool_call_end", "finish"] },
      text: { type: "string" },
    },
  },
  Error: {
    type: "object",
    properties: {
      error: { type: "string" },
    },
  },
  WorkflowRunRequest: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      userId: { type: "string" },
    },
  },
};

function buildAgentDescription(agent: any): string {
  const parts: string[] = [];
  parts.push(`**Model:** \`${agent.providerId}/${agent.modelId}\``);

  if (typeof agent.instructions === "string") {
    const instr = agent.instructions.length > 200 ? `${agent.instructions.slice(0, 200)}…` : agent.instructions;
    parts.push(`**Instructions:** ${instr}`);
  }

  if (agent.tools?.length > 0) {
    const toolNames = agent.tools.map((t: any) => `\`${t.name}\``).join(", ");
    parts.push(`**Tools:** ${toolNames}`);
  }

  if (agent.hasStructuredOutput) {
    parts.push("**Structured Output:** Enabled");
  }

  return parts.join("\n\n");
}

export function generateOpenAPISpec(routerOpts: RouterOptions, swaggerOpts: SwaggerOptions = {}): OpenAPISpec {
  const prefix = swaggerOpts.routePrefix ?? "";

  const providers = new Set<string>();
  if (routerOpts.agents) {
    for (const agent of Object.values(routerOpts.agents)) {
      providers.add((agent as any).providerId ?? "unknown");
    }
  }

  const securitySchemes: Record<string, unknown> = {};
  const securityRequirements: Array<Record<string, string[]>> = [];

  if (providers.has("openai")) {
    securitySchemes.OpenAIKey = {
      type: "apiKey",
      in: "header",
      name: "x-openai-api-key",
      description: "OpenAI API key (sk-...)",
    };
    securityRequirements.push({ OpenAIKey: [] });
  }
  if (providers.has("google")) {
    securitySchemes.GoogleKey = {
      type: "apiKey",
      in: "header",
      name: "x-google-api-key",
      description: "Google AI API key (AIza...)",
    };
    securityRequirements.push({ GoogleKey: [] });
  }
  if (providers.has("anthropic")) {
    securitySchemes.AnthropicKey = {
      type: "apiKey",
      in: "header",
      name: "x-anthropic-api-key",
      description: "Anthropic API key (sk-ant-...)",
    };
    securityRequirements.push({ AnthropicKey: [] });
  }

  securitySchemes.GenericKey = {
    type: "apiKey",
    in: "header",
    name: "x-api-key",
    description: "Generic API key (used if provider-specific key is not set)",
  };

  const spec: OpenAPISpec = {
    openapi: "3.0.3",
    info: {
      title: swaggerOpts.title ?? "Agentium API",
      description:
        swaggerOpts.description ?? "Auto-generated API documentation for Agentium agents, teams, and workflows.",
      version: swaggerOpts.version ?? "1.0.0",
    },
    paths: {},
    components: {
      schemas: SCHEMAS as Record<string, unknown>,
      securitySchemes,
    },
    security: securityRequirements,
    tags: [],
  };

  if (swaggerOpts.servers) {
    spec.servers = swaggerOpts.servers;
  }

  if (routerOpts.agents && Object.keys(routerOpts.agents).length > 0) {
    spec.tags.push({ name: "Agents", description: "Agent endpoints for running and streaming AI agents" });

    for (const [name, agent] of Object.entries(routerOpts.agents)) {
      const agentDesc = buildAgentDescription(agent);

      let responseSchemaRef = "#/components/schemas/RunOutput";

      const zodSchema = (agent as any).structuredOutputSchema;
      if (zodSchema) {
        const structuredJsonSchema = zodSchemaToJsonSchema(zodSchema);
        if (structuredJsonSchema) {
          const schemaName = `RunOutput_${name}`;
          (spec.components.schemas as Record<string, unknown>)[schemaName] = {
            type: "object",
            properties: {
              text: { type: "string", description: "Raw agent response text" },
              toolCalls: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    toolCallId: { type: "string" },
                    toolName: { type: "string" },
                    result: {},
                  },
                },
              },
              usage: {
                type: "object",
                properties: {
                  promptTokens: { type: "number" },
                  completionTokens: { type: "number" },
                  totalTokens: { type: "number" },
                  reasoningTokens: { type: "number", description: "Tokens used for chain-of-thought reasoning" },
                  cachedTokens: { type: "number", description: "Prompt tokens served from cache" },
                  audioInputTokens: { type: "number", description: "Audio input tokens" },
                  audioOutputTokens: { type: "number", description: "Audio output tokens" },
                  providerMetrics: {
                    type: "object",
                    description: "Raw usage metrics from the underlying provider API",
                  },
                },
              },
              structured: {
                ...structuredJsonSchema,
                description: "Parsed structured output",
              },
              durationMs: { type: "number" },
            },
          };
          responseSchemaRef = `#/components/schemas/${schemaName}`;
        }
      }

      spec.paths[`${prefix}/agents/${name}/run`] = {
        post: {
          tags: ["Agents"],
          summary: `Run agent: ${name}`,
          description: agentDesc,
          operationId: `runAgent_${name}`,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RunRequest" },
              },
              "multipart/form-data": {
                schema: { $ref: "#/components/schemas/MultipartRunRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Agent run result",
              content: {
                "application/json": {
                  schema: { $ref: responseSchemaRef },
                },
              },
            },
            "400": {
              description: "Bad request",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "500": {
              description: "Internal server error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      };

      spec.paths[`${prefix}/agents/${name}/stream`] = {
        post: {
          tags: ["Agents"],
          summary: `Stream agent: ${name}`,
          description: `Stream responses from agent **${name}** via Server-Sent Events.\n\n${agentDesc}`,
          operationId: `streamAgent_${name}`,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RunRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "SSE stream of agent chunks",
              content: {
                "text/event-stream": {
                  schema: { $ref: "#/components/schemas/StreamChunk" },
                },
              },
            },
            "400": {
              description: "Bad request",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      };
    }
  }

  if (routerOpts.teams && Object.keys(routerOpts.teams).length > 0) {
    spec.tags.push({ name: "Teams", description: "Team endpoints for multi-agent coordination" });

    for (const name of Object.keys(routerOpts.teams)) {
      spec.paths[`${prefix}/teams/${name}/run`] = {
        post: {
          tags: ["Teams"],
          summary: `Run team: ${name}`,
          operationId: `runTeam_${name}`,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RunRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Team run result",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/RunOutput" },
                },
              },
            },
            "400": {
              description: "Bad request",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "500": {
              description: "Internal server error",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      };

      spec.paths[`${prefix}/teams/${name}/stream`] = {
        post: {
          tags: ["Teams"],
          summary: `Stream team: ${name}`,
          operationId: `streamTeam_${name}`,
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/RunRequest" } } },
          },
          responses: {
            "200": {
              description: "SSE stream",
              content: { "text/event-stream": { schema: { $ref: "#/components/schemas/StreamChunk" } } },
            },
            "400": {
              description: "Bad request",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      };
    }
  }

  if (routerOpts.workflows && Object.keys(routerOpts.workflows).length > 0) {
    spec.tags.push({ name: "Workflows", description: "Workflow endpoints for step-based pipelines" });

    for (const name of Object.keys(routerOpts.workflows)) {
      spec.paths[`${prefix}/workflows/${name}/run`] = {
        post: {
          tags: ["Workflows"],
          summary: `Run workflow: ${name}`,
          operationId: `runWorkflow_${name}`,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WorkflowRunRequest" },
              },
            },
          },
          responses: {
            "200": { description: "Workflow result", content: { "application/json": { schema: { type: "object" } } } },
            "500": {
              description: "Internal server error",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      };
    }
  }

  return spec;
}

export function serveSwaggerUI(spec: OpenAPISpec) {
  let swaggerUiExpress: any;
  try {
    swaggerUiExpress = _require("swagger-ui-express");
  } catch {
    throw new Error("swagger-ui-express is required for Swagger UI. Install it: npm install swagger-ui-express");
  }

  return {
    setup: swaggerUiExpress.setup(spec, {
      customCss: ".swagger-ui .topbar { display: none }",
      customSiteTitle: spec.info.title,
    }),
    serve: swaggerUiExpress.serve,
  };
}
