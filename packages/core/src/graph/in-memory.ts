import { v4 as uuidv4 } from "uuid";
import type {
  GraphEdge,
  GraphNode,
  GraphNodeQuery,
  GraphSearchOptions,
  GraphStore,
  GraphTraversalOptions,
} from "./types.js";

export class InMemoryGraphStore implements GraphStore {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private outEdges = new Map<string, Set<string>>();
  private inEdges = new Map<string, Set<string>>();

  async initialize(): Promise<void> {}

  async addNode(node: Omit<GraphNode, "createdAt" | "updatedAt">): Promise<GraphNode> {
    const full: GraphNode = {
      ...node,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.nodes.set(full.id, full);
    if (!this.outEdges.has(full.id)) this.outEdges.set(full.id, new Set());
    if (!this.inEdges.has(full.id)) this.inEdges.set(full.id, new Set());
    return full;
  }

  async getNode(id: string): Promise<GraphNode | null> {
    return this.nodes.get(id) ?? null;
  }

  async updateNode(
    id: string,
    patch: Partial<Pick<GraphNode, "name" | "properties" | "invalidatedAt">>,
  ): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) return;
    if (patch.name !== undefined) node.name = patch.name;
    if (patch.properties !== undefined) node.properties = { ...node.properties, ...patch.properties };
    if (patch.invalidatedAt !== undefined) node.invalidatedAt = patch.invalidatedAt;
    node.updatedAt = new Date();
  }

  async deleteNode(id: string): Promise<void> {
    this.nodes.delete(id);
    const out = this.outEdges.get(id);
    if (out) {
      for (const edgeId of out) {
        const edge = this.edges.get(edgeId);
        if (edge) {
          this.inEdges.get(edge.targetId)?.delete(edgeId);
        }
        this.edges.delete(edgeId);
      }
    }
    const inc = this.inEdges.get(id);
    if (inc) {
      for (const edgeId of inc) {
        const edge = this.edges.get(edgeId);
        if (edge) {
          this.outEdges.get(edge.sourceId)?.delete(edgeId);
        }
        this.edges.delete(edgeId);
      }
    }
    this.outEdges.delete(id);
    this.inEdges.delete(id);
  }

  async findNodes(query: GraphNodeQuery): Promise<GraphNode[]> {
    const results: GraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (query.type && node.type !== query.type) continue;
      if (query.name && !node.name.toLowerCase().includes(query.name.toLowerCase())) continue;
      if (query.properties) {
        let match = true;
        for (const [k, v] of Object.entries(query.properties)) {
          if (node.properties[k] !== v) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }
      results.push(node);
    }
    return results;
  }

  async addEdge(edge: Omit<GraphEdge, "id" | "createdAt">): Promise<GraphEdge> {
    const full: GraphEdge = {
      ...edge,
      id: uuidv4(),
      createdAt: new Date(),
    };
    this.edges.set(full.id, full);

    if (!this.outEdges.has(full.sourceId)) this.outEdges.set(full.sourceId, new Set());
    this.outEdges.get(full.sourceId)!.add(full.id);

    if (!this.inEdges.has(full.targetId)) this.inEdges.set(full.targetId, new Set());
    this.inEdges.get(full.targetId)!.add(full.id);

    return full;
  }

  async getEdges(nodeId: string, direction: "in" | "out" | "both" = "both"): Promise<GraphEdge[]> {
    const result: GraphEdge[] = [];
    if (direction === "out" || direction === "both") {
      for (const edgeId of this.outEdges.get(nodeId) ?? []) {
        const edge = this.edges.get(edgeId);
        if (edge) result.push(edge);
      }
    }
    if (direction === "in" || direction === "both") {
      for (const edgeId of this.inEdges.get(nodeId) ?? []) {
        const edge = this.edges.get(edgeId);
        if (edge) result.push(edge);
      }
    }
    return result;
  }

  async deleteEdge(id: string): Promise<void> {
    const edge = this.edges.get(id);
    if (!edge) return;
    this.outEdges.get(edge.sourceId)?.delete(id);
    this.inEdges.get(edge.targetId)?.delete(id);
    this.edges.delete(id);
  }

  async traverse(
    startNodeId: string,
    options?: GraphTraversalOptions,
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const maxDepth = options?.maxDepth ?? 3;
    const visitedNodes = new Set<string>();
    const resultNodes: GraphNode[] = [];
    const resultEdges: GraphEdge[] = [];
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: startNodeId, depth: 0 }];

    while (queue.length > 0) {
      const { nodeId, depth } = queue.shift()!;
      if (visitedNodes.has(nodeId)) continue;
      visitedNodes.add(nodeId);

      const node = this.nodes.get(nodeId);
      if (!node) continue;

      if (!options?.includeInvalid && node.invalidatedAt) continue;
      if (options?.nodeTypes && !options.nodeTypes.includes(node.type)) {
        if (nodeId !== startNodeId) continue;
      }

      resultNodes.push(node);

      if (depth >= maxDepth) continue;

      const allEdges = await this.getEdges(nodeId);
      for (const edge of allEdges) {
        if (!options?.includeInvalid && edge.invalidatedAt) continue;
        if (options?.edgeTypes && !options.edgeTypes.includes(edge.type)) continue;

        resultEdges.push(edge);
        const neighborId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
        if (!visitedNodes.has(neighborId)) {
          queue.push({ nodeId: neighborId, depth: depth + 1 });
        }
      }
    }

    return { nodes: resultNodes, edges: resultEdges };
  }

  async search(query: string, options?: GraphSearchOptions): Promise<GraphNode[]> {
    const q = query.toLowerCase();
    const limit = options?.limit ?? 10;
    const results: Array<{ node: GraphNode; score: number }> = [];

    for (const node of this.nodes.values()) {
      if (options?.nodeTypes && !options.nodeTypes.includes(node.type)) continue;
      if (node.invalidatedAt) continue;

      let score = 0;
      if (node.name.toLowerCase() === q) score += 10;
      else if (node.name.toLowerCase().includes(q)) score += 5;

      const propsStr = JSON.stringify(node.properties).toLowerCase();
      if (propsStr.includes(q)) score += 3;

      if (node.type.toLowerCase().includes(q)) score += 2;

      if (score > 0) results.push({ node, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.node);
  }

  async close(): Promise<void> {
    this.nodes.clear();
    this.edges.clear();
    this.outEdges.clear();
    this.inEdges.clear();
  }
}
