import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/**
 * Low-level Cypher execution API used by `GraphRAGRetriever`.
 *
 * Distinct from the existing `GraphStore` interface in `./types.ts`, which is
 * a higher-level semantic entity graph (nodes/edges by entity type, used by
 * `GraphMemory`). `CypherStore` exposes raw Cypher for LLM-to-Cypher use cases.
 */
export interface CypherRecord {
  values: Record<string, unknown>;
}

export interface CypherSchema {
  nodeLabels: string[];
  relationshipTypes: string[];
  propertyKeys?: string[];
}

export interface CypherStore {
  readonly providerId: string;
  connect(): Promise<void>;
  runCypher(cypher: string, params?: Record<string, unknown>): Promise<CypherRecord[]>;
  getSchema(): Promise<CypherSchema>;
  close(): Promise<void>;
}

export interface Neo4jCypherStoreConfig {
  uri?: string;
  username?: string;
  password?: string;
  database?: string;
}

/**
 * Neo4j-backed Cypher store. Lazily loads `neo4j-driver` (already an optional
 * peer dep on @agentium/core).
 */
export class Neo4jCypherStore implements CypherStore {
  readonly providerId: string = "neo4j";
  private driver: any = null;
  private database: string | undefined;
  private uri: string;
  private username: string;
  private password: string;

  constructor(config: Neo4jCypherStoreConfig = {}) {
    this.uri = config.uri ?? process.env.NEO4J_URI ?? "bolt://localhost:7687";
    this.username = config.username ?? process.env.NEO4J_USER ?? "neo4j";
    this.password = config.password ?? process.env.NEO4J_PASSWORD ?? "neo4j";
    this.database = config.database;
  }

  async connect(): Promise<void> {
    if (this.driver) return;
    try {
      const neo4j = _require("neo4j-driver");
      this.driver = neo4j.driver(this.uri, neo4j.auth.basic(this.username, this.password));
      await this.driver.verifyConnectivity();
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("neo4j-driver is required for Neo4jCypherStore. Install it: npm install neo4j-driver");
      }
      throw e;
    }
  }

  private async ensure(): Promise<any> {
    if (!this.driver) await this.connect();
    return this.driver;
  }

  async runCypher(cypher: string, params: Record<string, unknown> = {}): Promise<CypherRecord[]> {
    const driver = await this.ensure();
    const session = driver.session(this.database ? { database: this.database } : undefined);
    try {
      const result = await session.run(cypher, params);
      return result.records.map((r: any) => {
        const values: Record<string, unknown> = {};
        for (const k of r.keys) values[k] = r.get(k);
        return { values };
      });
    } finally {
      await session.close();
    }
  }

  async getSchema(): Promise<CypherSchema> {
    const nodeLabels = (await this.runCypher("CALL db.labels()")).flatMap((r) => Object.values(r.values).map(String));
    const relationshipTypes = (await this.runCypher("CALL db.relationshipTypes()")).flatMap((r) =>
      Object.values(r.values).map(String),
    );
    const propertyKeys = (await this.runCypher("CALL db.propertyKeys()")).flatMap((r) =>
      Object.values(r.values).map(String),
    );
    return { nodeLabels, relationshipTypes, propertyKeys };
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }
}

/**
 * Memgraph reuses the Bolt protocol so we just inherit Neo4jCypherStore.
 */
export class MemgraphCypherStore extends Neo4jCypherStore {
  override readonly providerId = "memgraph";

  constructor(config: Neo4jCypherStoreConfig = {}) {
    super({
      uri: config.uri ?? process.env.MEMGRAPH_URI ?? "bolt://localhost:7687",
      username: config.username ?? process.env.MEMGRAPH_USER ?? "",
      password: config.password ?? process.env.MEMGRAPH_PASSWORD ?? "",
      database: config.database,
    });
  }
}
