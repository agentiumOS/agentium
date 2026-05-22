import { v4 as uuidv4 } from "uuid";
import type { StorageDriver } from "../storage/driver.js";
import type { AgentVersion, VersionDiff } from "./types.js";

const NAMESPACE = "agent-versions";

export class VersionStore {
  private storage: StorageDriver;

  constructor(storage: StorageDriver) {
    this.storage = storage;
  }

  async save(version: Omit<AgentVersion, "versionId" | "createdAt">): Promise<AgentVersion> {
    const full: AgentVersion = {
      ...version,
      versionId: uuidv4(),
      createdAt: new Date(),
    };
    await this.storage.set(NAMESPACE, `${full.agentName}:${full.versionId}`, full);
    return full;
  }

  async load(agentName: string, versionId: string): Promise<AgentVersion | null> {
    return this.storage.get<AgentVersion>(NAMESPACE, `${agentName}:${versionId}`);
  }

  async list(agentName: string): Promise<AgentVersion[]> {
    const items = await this.storage.list<AgentVersion>(NAMESPACE, agentName);
    return items.map((i) => i.value).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async latest(agentName: string): Promise<AgentVersion | null> {
    const versions = await this.list(agentName);
    return versions[0] ?? null;
  }

  diff(v1: AgentVersion, v2: AgentVersion): VersionDiff[] {
    const diffs: VersionDiff[] = [];
    const fields: (keyof AgentVersion)[] = ["instructions", "modelId", "providerId", "temperature", "maxTokens"];

    for (const field of fields) {
      if (JSON.stringify(v1[field]) !== JSON.stringify(v2[field])) {
        diffs.push({ field, before: v1[field], after: v2[field] });
      }
    }

    const tools1 = JSON.stringify(v1.toolNames.sort());
    const tools2 = JSON.stringify(v2.toolNames.sort());
    if (tools1 !== tools2) {
      diffs.push({ field: "toolNames", before: v1.toolNames, after: v2.toolNames });
    }

    return diffs;
  }

  async delete(agentName: string, versionId: string): Promise<void> {
    await this.storage.delete(NAMESPACE, `${agentName}:${versionId}`);
  }
}
