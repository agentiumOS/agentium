import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { GraphStore } from "../../graph/types.js";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage } from "../../models/types.js";
import type { ToolDef } from "../../tools/types.js";

export interface GraphMemoryConfig {
  graphStore: GraphStore;
  model?: ModelProvider;
  autoExtract?: boolean;
  maxContextNodes?: number;
}

const EXTRACTION_PROMPT = `You are a knowledge graph extraction assistant. Analyze the conversation and extract entities and relationships.

For each entity, extract:
- id: a lowercase underscore-separated identifier
- type: "person" | "company" | "project" | "product" | "concept" | "location" | "other"
- name: the display name
- properties: key-value pairs of attributes

For each relationship, extract:
- sourceId: id of the source entity
- targetId: id of the target entity
- type: relationship type (e.g. "works_at", "manages", "uses", "located_in")
- properties: optional key-value attributes

Return ONLY a JSON object:
{"nodes": [{"id": "str", "type": "str", "name": "str", "properties": {}}], "relationships": [{"sourceId": "str", "targetId": "str", "type": "str", "properties": {}}]}

If nothing to extract, return {"nodes": [], "relationships": []}.

Known entities:
{knownEntities}

Conversation:
{conversation}`;

export class GraphMemory {
  private graphStore: GraphStore;
  private model?: ModelProvider;
  private autoExtract: boolean;
  private maxContextNodes: number;

  constructor(config: GraphMemoryConfig) {
    this.graphStore = config.graphStore;
    this.model = config.model;
    this.autoExtract = config.autoExtract ?? true;
    this.maxContextNodes = config.maxContextNodes ?? 10;
  }

  async initialize(): Promise<void> {
    await this.graphStore.initialize();
  }

  getStore(): GraphStore {
    return this.graphStore;
  }

  async getContextString(currentInput?: string): Promise<string> {
    if (!currentInput) return "";

    try {
      const nodes = await this.graphStore.search(currentInput, { limit: 5 });
      if (nodes.length === 0) return "";

      const parts: string[] = [];
      const seenNodes = new Set<string>();
      const seenEdges = new Set<string>();

      for (const node of nodes) {
        const { nodes: connected, edges } = await this.graphStore.traverse(node.id, {
          maxDepth: 2,
          includeInvalid: false,
        });

        for (const n of connected) {
          if (seenNodes.has(n.id) || seenNodes.size >= this.maxContextNodes) continue;
          seenNodes.add(n.id);
          const propsStr = Object.entries(n.properties)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          parts.push(`- ${n.name} (${n.type})${propsStr ? ` — ${propsStr}` : ""}`);
        }

        for (const e of edges) {
          if (seenEdges.has(e.id)) continue;
          seenEdges.add(e.id);
          const srcNode = connected.find((n) => n.id === e.sourceId);
          const tgtNode = connected.find((n) => n.id === e.targetId);
          if (srcNode && tgtNode) {
            parts.push(`  ${srcNode.name} --[${e.type}]--> ${tgtNode.name}`);
          }
        }
      }

      if (parts.length === 0) return "";
      return `Knowledge graph context:\n${parts.join("\n")}`;
    } catch {
      return "";
    }
  }

  async extractFromConversation(messages: ChatMessage[], fallbackModel?: ModelProvider): Promise<void> {
    if (!this.autoExtract) return;
    const model = this.model ?? fallbackModel;
    if (!model) return;

    try {
      const existing = await this.graphStore.findNodes({});
      const knownStr =
        existing.length > 0
          ? existing
              .slice(0, 20)
              .map((n) => `- ${n.name} (${n.type}) [${n.id}]`)
              .join("\n")
          : "(none)";

      const conversationStr = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => {
          const content = typeof m.content === "string" ? m.content : "(multimodal)";
          return `${m.role}: ${content}`;
        })
        .join("\n");

      const prompt = EXTRACTION_PROMPT.replace("{knownEntities}", knownStr).replace("{conversation}", conversationStr);

      const response = await model.generate([{ role: "user", content: prompt }], {
        temperature: 0,
        maxTokens: 1000,
      });

      const text = typeof response.message.content === "string" ? response.message.content : "";
      if (!text) return;

      const jsonStr = extractJsonObject(text);
      const parsed = JSON.parse(jsonStr);

      if (parsed?.nodes && Array.isArray(parsed.nodes)) {
        for (const n of parsed.nodes) {
          if (!n?.id || !n?.type || !n?.name) continue;
          const existingNode = await this.graphStore.getNode(n.id);
          if (existingNode) {
            await this.graphStore.updateNode(n.id, {
              properties: { ...existingNode.properties, ...n.properties },
            });
          } else {
            await this.graphStore.addNode({
              id: n.id,
              type: n.type,
              name: n.name,
              properties: n.properties ?? {},
              validFrom: new Date(),
            });
          }
        }
      }

      if (parsed?.relationships && Array.isArray(parsed.relationships)) {
        for (const r of parsed.relationships) {
          if (!r?.sourceId || !r?.targetId || !r?.type) continue;
          const existingEdges = await this.graphStore.getEdges(r.sourceId, "out");
          const duplicate = existingEdges.find(
            (e) => e.targetId === r.targetId && e.type === r.type && !e.invalidatedAt,
          );
          if (!duplicate) {
            await this.graphStore.addEdge({
              sourceId: r.sourceId,
              targetId: r.targetId,
              type: r.type,
              properties: r.properties ?? {},
              validFrom: new Date(),
            });
          }
        }
      }
    } catch (err) {
      console.warn("[GraphMemory] extractFromConversation failed:", (err as Error).message ?? err);
    }
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "query_graph",
        description:
          "Search the knowledge graph for entities by name or type. Returns matching entities with their properties and connections.",
        parameters: z.object({
          query: z.string().describe("Search term (entity name or keyword)"),
          type: z.string().optional().describe("Filter by entity type"),
        }),
        execute: async (args) => {
          const nodes = await this.graphStore.search(args.query as string, {
            nodeTypes: args.type ? [args.type as string] : undefined,
            limit: 10,
          });
          if (nodes.length === 0) return "No matching entities found in the knowledge graph.";
          const lines: string[] = [];
          for (const n of nodes) {
            const propsStr = Object.entries(n.properties)
              .filter(([, v]) => v != null)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ");
            lines.push(`[${n.id}] ${n.name} (${n.type})${propsStr ? ` {${propsStr}}` : ""}`);
          }
          return lines.join("\n");
        },
      },
      {
        name: "traverse_entity",
        description:
          "Traverse the knowledge graph starting from a specific entity. Returns connected entities and relationships up to a given depth.",
        parameters: z.object({
          entityId: z.string().describe("ID of the starting entity"),
          maxDepth: z.number().optional().describe("Maximum traversal depth (default: 2)"),
        }),
        execute: async (args) => {
          const { nodes, edges } = await this.graphStore.traverse(args.entityId as string, {
            maxDepth: (args.maxDepth as number) ?? 2,
            includeInvalid: false,
          });
          if (nodes.length === 0) return "Entity not found or no connections.";
          const lines: string[] = [];
          for (const n of nodes) {
            lines.push(`[${n.id}] ${n.name} (${n.type})`);
          }
          lines.push("--- Relationships ---");
          for (const e of edges) {
            const src = nodes.find((n) => n.id === e.sourceId);
            const tgt = nodes.find((n) => n.id === e.targetId);
            lines.push(`${src?.name ?? e.sourceId} --[${e.type}]--> ${tgt?.name ?? e.targetId}`);
          }
          return lines.join("\n");
        },
      },
      {
        name: "add_relationship",
        description: "Add a new relationship between two entities in the knowledge graph.",
        parameters: z.object({
          sourceId: z.string().describe("ID of the source entity"),
          targetId: z.string().describe("ID of the target entity"),
          type: z.string().describe("Relationship type (e.g. works_at, manages, uses)"),
        }),
        execute: async (args) => {
          const edge = await this.graphStore.addEdge({
            sourceId: args.sourceId as string,
            targetId: args.targetId as string,
            type: args.type as string,
            properties: {},
            validFrom: new Date(),
          });
          return `Relationship added: ${args.sourceId} --[${args.type}]--> ${args.targetId} (${edge.id})`;
        },
      },
    ];
  }
}

function extractJsonObject(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }

  return text.trim();
}
