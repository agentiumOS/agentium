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

  /**
   * Per-user filter: nodes are tagged with `properties._userId` at write time.
   * In context retrieval, anything without a matching `_userId` is filtered out.
   * Returns "" if no userId is provided so we never surface unscoped graph data.
   */
  private nodeBelongsTo(node: { properties: Record<string, unknown> }, userId: string): boolean {
    const owner = node.properties?._userId;
    return typeof owner === "string" && owner === userId;
  }

  async getContextString(currentInput?: string, userId?: string): Promise<string> {
    if (!currentInput) return "";
    if (!userId) return ""; // refuse to surface unscoped graph context

    try {
      const nodes = await this.graphStore.search(currentInput, { limit: 5 * 4 }); // over-fetch then filter
      const ownedSeeds = nodes.filter((n) => this.nodeBelongsTo(n, userId)).slice(0, 5);
      if (ownedSeeds.length === 0) return "";

      const parts: string[] = [];
      const seenNodes = new Set<string>();
      const seenEdges = new Set<string>();

      for (const node of ownedSeeds) {
        const { nodes: connected, edges } = await this.graphStore.traverse(node.id, {
          maxDepth: 2,
          includeInvalid: false,
        });

        for (const n of connected) {
          if (!this.nodeBelongsTo(n, userId)) continue;
          if (seenNodes.has(n.id) || seenNodes.size >= this.maxContextNodes) continue;
          seenNodes.add(n.id);
          const propsStr = Object.entries(n.properties)
            .filter(([k, v]) => k !== "_userId" && v != null)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          parts.push(`- ${n.name} (${n.type})${propsStr ? ` — ${propsStr}` : ""}`);
        }

        for (const e of edges) {
          if (seenEdges.has(e.id)) continue;
          const srcNode = connected.find((n) => n.id === e.sourceId);
          const tgtNode = connected.find((n) => n.id === e.targetId);
          if (!srcNode || !tgtNode) continue;
          if (!this.nodeBelongsTo(srcNode, userId) || !this.nodeBelongsTo(tgtNode, userId)) continue;
          seenEdges.add(e.id);
          parts.push(`  ${srcNode.name} --[${e.type}]--> ${tgtNode.name}`);
        }
      }

      if (parts.length === 0) return "";
      return `Knowledge graph context:\n${parts.join("\n")}`;
    } catch {
      return "";
    }
  }

  async extractFromConversation(
    userId: string | undefined,
    messages: ChatMessage[],
    fallbackModel?: ModelProvider,
  ): Promise<void> {
    if (!this.autoExtract) return;
    if (!userId) return; // never write unscoped graph data
    const model = this.model ?? fallbackModel;
    if (!model) return;

    try {
      // Limit known entities to those belonging to this user so the prompt
      // doesn't leak any other user's IDs into the LLM.
      const allExisting = await this.graphStore.findNodes({});
      const existing = allExisting.filter((n) => this.nodeBelongsTo(n, userId));
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
          // Namespace the id so two users' "google" entities never collide.
          const scopedId = `${userId}:${n.id}`;
          const existingNode = await this.graphStore.getNode(scopedId);
          if (existingNode && this.nodeBelongsTo(existingNode, userId)) {
            await this.graphStore.updateNode(scopedId, {
              properties: { ...existingNode.properties, ...n.properties, _userId: userId },
            });
          } else {
            await this.graphStore.addNode({
              id: scopedId,
              type: n.type,
              name: n.name,
              properties: { ...(n.properties ?? {}), _userId: userId },
              validFrom: new Date(),
            });
          }
        }
      }

      if (parsed?.relationships && Array.isArray(parsed.relationships)) {
        for (const r of parsed.relationships) {
          if (!r?.sourceId || !r?.targetId || !r?.type) continue;
          const scopedSource = `${userId}:${r.sourceId}`;
          const scopedTarget = `${userId}:${r.targetId}`;
          const existingEdges = await this.graphStore.getEdges(scopedSource, "out");
          const duplicate = existingEdges.find(
            (e) => e.targetId === scopedTarget && e.type === r.type && !e.invalidatedAt,
          );
          if (!duplicate) {
            await this.graphStore.addEdge({
              sourceId: scopedSource,
              targetId: scopedTarget,
              type: r.type,
              properties: { ...(r.properties ?? {}), _userId: userId },
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
        execute: async (args, ctx) => {
          if (!ctx.userId) return "No user identified for this session.";
          const nodes = await this.graphStore.search(args.query as string, {
            nodeTypes: args.type ? [args.type as string] : undefined,
            limit: 40, // over-fetch then filter by owner
          });
          const owned = nodes.filter((n) => this.nodeBelongsTo(n, ctx.userId!)).slice(0, 10);
          if (owned.length === 0) return "No matching entities found in the knowledge graph.";
          const lines: string[] = [];
          for (const n of owned) {
            const propsStr = Object.entries(n.properties)
              .filter(([k, v]) => k !== "_userId" && v != null)
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
        execute: async (args, ctx) => {
          if (!ctx.userId) return "No user identified for this session.";
          // Scope the lookup id — the agent doesn't see the `userId:` prefix.
          const rawId = args.entityId as string;
          const scopedId = rawId.startsWith(`${ctx.userId}:`) ? rawId : `${ctx.userId}:${rawId}`;
          const { nodes, edges } = await this.graphStore.traverse(scopedId, {
            maxDepth: (args.maxDepth as number) ?? 2,
            includeInvalid: false,
          });
          const ownedNodes = nodes.filter((n) => this.nodeBelongsTo(n, ctx.userId!));
          if (ownedNodes.length === 0) return "Entity not found or no connections.";
          const lines: string[] = [];
          for (const n of ownedNodes) {
            lines.push(`[${n.id}] ${n.name} (${n.type})`);
          }
          lines.push("--- Relationships ---");
          for (const e of edges) {
            const src = ownedNodes.find((n) => n.id === e.sourceId);
            const tgt = ownedNodes.find((n) => n.id === e.targetId);
            if (src && tgt) lines.push(`${src.name} --[${e.type}]--> ${tgt.name}`);
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
        execute: async (args, ctx) => {
          if (!ctx.userId) return "No user identified for this session.";
          const src = (args.sourceId as string);
          const tgt = (args.targetId as string);
          const scopedSrc = src.startsWith(`${ctx.userId}:`) ? src : `${ctx.userId}:${src}`;
          const scopedTgt = tgt.startsWith(`${ctx.userId}:`) ? tgt : `${ctx.userId}:${tgt}`;
          const edge = await this.graphStore.addEdge({
            sourceId: scopedSrc,
            targetId: scopedTgt,
            type: args.type as string,
            properties: { _userId: ctx.userId },
            validFrom: new Date(),
          });
          return `Relationship added: ${src} --[${args.type}]--> ${tgt} (${edge.id})`;
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
