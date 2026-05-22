export interface CulturalKnowledge {
  id: string;
  name: string;
  content: string;
  summary?: string;
  categories?: string[];
  notes?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  agentId?: string;
}
