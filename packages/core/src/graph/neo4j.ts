import type {
  GraphEdge,
  GraphNode,
  GraphNodeQuery,
  GraphSearchOptions,
  GraphStore,
  GraphTraversalOptions,
} from "./types.js";

export interface Neo4jGraphStoreConfig {
  uri: string;
  username: string;
  password: string;
  database?: string;
}

/**
 * Neo4j-backed graph store. Requires `neo4j-driver` as a peer dependency.
 *
 * Install: npm install neo4j-driver
 */
export class Neo4jGraphStore implements GraphStore {
  private driver: any;
  private database: string;
  private config: Neo4jGraphStoreConfig;

  constructor(config: Neo4jGraphStoreConfig) {
    this.config = config;
    this.database = config.database ?? "neo4j";
  }

  async initialize(): Promise<void> {
    let neo4j: any;
    try {
      neo4j = await import("neo4j-driver");
    } catch {
      throw new Error('Neo4jGraphStore requires the "neo4j-driver" package. Install it with: npm install neo4j-driver');
    }
    const driverFn = neo4j.default?.driver ?? neo4j.driver;
    const authFn = neo4j.default?.auth ?? neo4j.auth;
    this.driver = driverFn(this.config.uri, authFn.basic(this.config.username, this.config.password));
    await this.driver.verifyConnectivity();

    const session = this.driver.session({ database: this.database });
    try {
      await session.run("CREATE INDEX IF NOT EXISTS FOR (n:GraphNode) ON (n.id)");
      await session.run("CREATE INDEX IF NOT EXISTS FOR ()-[r:GRAPH_EDGE]-() ON (r.id)");
    } finally {
      await session.close();
    }
  }

  private session() {
    return this.driver.session({ database: this.database });
  }

  async addNode(node: Omit<GraphNode, "createdAt" | "updatedAt">): Promise<GraphNode> {
    const now = new Date();
    const full: GraphNode = { ...node, createdAt: now, updatedAt: now };
    const session = this.session();
    try {
      await session.run(
        `MERGE (n:GraphNode {id: $id})
         SET n.type = $type, n.name = $name, n.properties = $props,
             n.validFrom = $validFrom, n.invalidatedAt = $invalidatedAt,
             n.createdAt = $createdAt, n.updatedAt = $updatedAt`,
        {
          id: full.id,
          type: full.type,
          name: full.name,
          props: JSON.stringify(full.properties),
          validFrom: full.validFrom.toISOString(),
          invalidatedAt: full.invalidatedAt?.toISOString() ?? null,
          createdAt: full.createdAt.toISOString(),
          updatedAt: full.updatedAt.toISOString(),
        },
      );
      return full;
    } finally {
      await session.close();
    }
  }

  private recordToNode(record: any): GraphNode {
    const n = record.properties ?? record;
    return {
      id: n.id,
      type: n.type,
      name: n.name,
      properties: JSON.parse(n.properties ?? "{}"),
      validFrom: new Date(n.validFrom),
      invalidatedAt: n.invalidatedAt ? new Date(n.invalidatedAt) : undefined,
      createdAt: new Date(n.createdAt),
      updatedAt: new Date(n.updatedAt),
    };
  }

  private recordToEdge(record: any): GraphEdge {
    const e = record.properties ?? record;
    return {
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      type: e.type,
      properties: JSON.parse(e.properties ?? "{}"),
      weight: e.weight != null ? Number(e.weight) : undefined,
      validFrom: new Date(e.validFrom),
      invalidatedAt: e.invalidatedAt ? new Date(e.invalidatedAt) : undefined,
      createdAt: new Date(e.createdAt),
    };
  }

  async getNode(id: string): Promise<GraphNode | null> {
    const session = this.session();
    try {
      const result = await session.run("MATCH (n:GraphNode {id: $id}) RETURN n", { id });
      if (result.records.length === 0) return null;
      return this.recordToNode(result.records[0].get("n"));
    } finally {
      await session.close();
    }
  }

  async updateNode(
    id: string,
    patch: Partial<Pick<GraphNode, "name" | "properties" | "invalidatedAt">>,
  ): Promise<void> {
    const session = this.session();
    try {
      const sets: string[] = ["n.updatedAt = $now"];
      const params: Record<string, unknown> = { id, now: new Date().toISOString() };

      if (patch.name !== undefined) {
        sets.push("n.name = $name");
        params.name = patch.name;
      }
      if (patch.properties !== undefined) {
        sets.push("n.properties = $props");
        params.props = JSON.stringify(patch.properties);
      }
      if (patch.invalidatedAt !== undefined) {
        sets.push("n.invalidatedAt = $invalidatedAt");
        params.invalidatedAt = patch.invalidatedAt?.toISOString() ?? null;
      }

      await session.run(`MATCH (n:GraphNode {id: $id}) SET ${sets.join(", ")}`, params);
    } finally {
      await session.close();
    }
  }

  async deleteNode(id: string): Promise<void> {
    const session = this.session();
    try {
      await session.run("MATCH (n:GraphNode {id: $id}) DETACH DELETE n", { id });
    } finally {
      await session.close();
    }
  }

  async findNodes(query: GraphNodeQuery): Promise<GraphNode[]> {
    const session = this.session();
    try {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (query.type) {
        conditions.push("n.type = $type");
        params.type = query.type;
      }
      if (query.name) {
        conditions.push("toLower(n.name) CONTAINS toLower($name)");
        params.name = query.name;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const result = await session.run(`MATCH (n:GraphNode) ${where} RETURN n LIMIT 100`, params);
      return result.records.map((r: any) => this.recordToNode(r.get("n")));
    } finally {
      await session.close();
    }
  }

  async addEdge(edge: Omit<GraphEdge, "id" | "createdAt">): Promise<GraphEdge> {
    const { v4: uuidv4 } = await import("uuid");
    const full: GraphEdge = { ...edge, id: uuidv4(), createdAt: new Date() };
    const session = this.session();
    try {
      await session.run(
        `MATCH (s:GraphNode {id: $sourceId}), (t:GraphNode {id: $targetId})
         CREATE (s)-[r:GRAPH_EDGE {
           id: $id, sourceId: $sourceId, targetId: $targetId,
           type: $type, properties: $props, weight: $weight,
           validFrom: $validFrom, invalidatedAt: $invalidatedAt,
           createdAt: $createdAt
         }]->(t)`,
        {
          id: full.id,
          sourceId: full.sourceId,
          targetId: full.targetId,
          type: full.type,
          props: JSON.stringify(full.properties),
          weight: full.weight ?? null,
          validFrom: full.validFrom.toISOString(),
          invalidatedAt: full.invalidatedAt?.toISOString() ?? null,
          createdAt: full.createdAt.toISOString(),
        },
      );
      return full;
    } finally {
      await session.close();
    }
  }

  async getEdges(nodeId: string, direction: "in" | "out" | "both" = "both"): Promise<GraphEdge[]> {
    const session = this.session();
    try {
      let query: string;
      if (direction === "out") query = "MATCH (n:GraphNode {id: $id})-[r:GRAPH_EDGE]->() RETURN r";
      else if (direction === "in") query = "MATCH ()-[r:GRAPH_EDGE]->(n:GraphNode {id: $id}) RETURN r";
      else query = "MATCH (n:GraphNode {id: $id})-[r:GRAPH_EDGE]-() RETURN r";

      const result = await session.run(query, { id: nodeId });
      return result.records.map((rec: any) => this.recordToEdge(rec.get("r")));
    } finally {
      await session.close();
    }
  }

  async deleteEdge(id: string): Promise<void> {
    const session = this.session();
    try {
      await session.run("MATCH ()-[r:GRAPH_EDGE {id: $id}]-() DELETE r", { id });
    } finally {
      await session.close();
    }
  }

  async traverse(
    startNodeId: string,
    options?: GraphTraversalOptions,
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const maxDepth = options?.maxDepth ?? 3;
    const session = this.session();
    try {
      const conditions: string[] = [];
      if (!options?.includeInvalid) {
        conditions.push("ALL(n IN nodes(p) WHERE n.invalidatedAt IS NULL)");
        conditions.push("ALL(r IN relationships(p) WHERE r.invalidatedAt IS NULL)");
      }
      if (options?.edgeTypes?.length) {
        conditions.push(`ALL(r IN relationships(p) WHERE r.type IN $edgeTypes)`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const params: Record<string, unknown> = {
        startId: startNodeId,
        maxDepth,
        edgeTypes: options?.edgeTypes ?? [],
      };

      const result = await session.run(
        `MATCH p = (start:GraphNode {id: $startId})-[*0..${maxDepth}]-(end:GraphNode)
         ${where}
         UNWIND nodes(p) AS n
         UNWIND relationships(p) AS r
         RETURN DISTINCT n, r`,
        params,
      );

      const nodesMap = new Map<string, GraphNode>();
      const edgesMap = new Map<string, GraphEdge>();

      for (const record of result.records) {
        const node = this.recordToNode(record.get("n"));
        if (options?.nodeTypes && !options.nodeTypes.includes(node.type)) continue;
        nodesMap.set(node.id, node);

        const edge = this.recordToEdge(record.get("r"));
        edgesMap.set(edge.id, edge);
      }

      return { nodes: [...nodesMap.values()], edges: [...edgesMap.values()] };
    } finally {
      await session.close();
    }
  }

  async search(query: string, options?: GraphSearchOptions): Promise<GraphNode[]> {
    const session = this.session();
    try {
      const conditions: string[] = ["n.invalidatedAt IS NULL", "toLower(n.name) CONTAINS toLower($query)"];
      if (options?.nodeTypes?.length) {
        conditions.push("n.type IN $nodeTypes");
      }

      const result = await session.run(`MATCH (n:GraphNode) WHERE ${conditions.join(" AND ")} RETURN n LIMIT $limit`, {
        query,
        nodeTypes: options?.nodeTypes ?? [],
        limit: options?.limit ?? 10,
      });

      return result.records.map((r: any) => this.recordToNode(r.get("n")));
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    if (this.driver) await this.driver.close();
  }
}
