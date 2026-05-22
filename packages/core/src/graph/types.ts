export interface GraphNode {
  id: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
  validFrom: Date;
  invalidatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  properties: Record<string, unknown>;
  weight?: number;
  validFrom: Date;
  invalidatedAt?: Date;
  createdAt: Date;
}

export interface GraphTraversalOptions {
  maxDepth?: number;
  edgeTypes?: string[];
  nodeTypes?: string[];
  includeInvalid?: boolean;
}

export interface GraphNodeQuery {
  type?: string;
  name?: string;
  properties?: Record<string, unknown>;
}

export interface GraphSearchOptions {
  nodeTypes?: string[];
  limit?: number;
}

export interface GraphStore {
  initialize(): Promise<void>;

  addNode(node: Omit<GraphNode, "createdAt" | "updatedAt">): Promise<GraphNode>;
  getNode(id: string): Promise<GraphNode | null>;
  updateNode(id: string, patch: Partial<Pick<GraphNode, "name" | "properties" | "invalidatedAt">>): Promise<void>;
  deleteNode(id: string): Promise<void>;
  findNodes(query: GraphNodeQuery): Promise<GraphNode[]>;

  addEdge(edge: Omit<GraphEdge, "id" | "createdAt">): Promise<GraphEdge>;
  getEdges(nodeId: string, direction?: "in" | "out" | "both"): Promise<GraphEdge[]>;
  deleteEdge(id: string): Promise<void>;

  traverse(startNodeId: string, options?: GraphTraversalOptions): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;

  search(query: string, options?: GraphSearchOptions): Promise<GraphNode[]>;

  close(): Promise<void>;
}
