import type { StorageDriver, ToolDef, Toolkit, ToolkitMeta } from "@agentium/core";
import { collectToolkitTools, toolkitCatalog } from "@agentium/core";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Persisted toolkit configuration. */
export interface ToolkitConfig {
  /** Toolkit id from the catalog (e.g. "github", "slack"). */
  toolkitId: string;
  /** User-chosen instance name — allows multiple configs of same type. */
  instanceName: string;
  /** Config values (API keys, connection strings, etc.). */
  config: Record<string, unknown>;
  /** Whether this toolkit is active (instantiated). */
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Toolkit config with secret fields masked for API responses. */
export type MaskedToolkitConfig = Omit<ToolkitConfig, "config"> & {
  config: Record<string, unknown>;
};

const NS_TOOLKIT_CONFIGS = "agentium:admin:toolkit-configs";

/* ------------------------------------------------------------------ */
/*  Secret masking                                                     */
/* ------------------------------------------------------------------ */

function getSecretFields(toolkitId: string): Set<string> {
  const meta = toolkitCatalog.get(toolkitId);
  if (!meta) return new Set();
  const fields = new Set<string>();
  for (const field of meta.configFields) {
    if (field.secret) fields.add(field.name);
  }
  return fields;
}

function maskSecrets(cfg: ToolkitConfig): MaskedToolkitConfig {
  const secretFields = getSecretFields(cfg.toolkitId);
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg.config)) {
    if (secretFields.has(key) && typeof value === "string" && value.length > 0) {
      masked[key] = value.length > 8 ? `${value.slice(0, 4)}${"*".repeat(Math.min(value.length - 4, 20))}` : "********";
    } else {
      masked[key] = value;
    }
  }
  return { ...cfg, config: masked };
}

/* ------------------------------------------------------------------ */
/*  ToolkitManager                                                     */
/* ------------------------------------------------------------------ */

/**
 * Manages toolkit configurations: persists credentials, instantiates
 * toolkits, and maintains a live tool library that agents can use.
 *
 * Secret fields (API keys, tokens) are stored as-is in the storage driver
 * but are always masked in API responses.
 */
export class ToolkitManager {
  private readonly storage: StorageDriver;
  private readonly liveToolkits = new Map<string, Toolkit>();
  private mergedToolLibrary: Record<string, ToolDef> = {};

  constructor(storage: StorageDriver) {
    this.storage = storage;
  }

  /* ── Catalog ──────────────────────────────────────────────────── */

  /** List all available toolkit types from the catalog. */
  listCatalog(): Omit<ToolkitMeta, "factory">[] {
    return toolkitCatalog.list();
  }

  /** Get a single catalog entry. */
  getCatalogEntry(id: string): Omit<ToolkitMeta, "factory"> | undefined {
    return toolkitCatalog.get(id);
  }

  /* ── Config CRUD ──────────────────────────────────────────────── */

  /** Save a toolkit config and optionally instantiate it. */
  async saveConfig(cfg: ToolkitConfig): Promise<MaskedToolkitConfig> {
    if (!toolkitCatalog.has(cfg.toolkitId)) {
      throw new Error(`Unknown toolkit type "${cfg.toolkitId}"`);
    }

    const now = new Date().toISOString();
    const toSave: ToolkitConfig = {
      ...cfg,
      createdAt: cfg.createdAt ?? now,
      updatedAt: now,
    };

    await this.storage.set(NS_TOOLKIT_CONFIGS, toSave.instanceName, toSave);

    if (toSave.enabled) {
      this.instantiate(toSave);
    } else {
      this.deactivate(toSave.instanceName);
    }

    return maskSecrets(toSave);
  }

  /** Load a toolkit config (masked). */
  async loadConfig(instanceName: string): Promise<MaskedToolkitConfig | null> {
    const raw = await this.storage.get<ToolkitConfig>(NS_TOOLKIT_CONFIGS, instanceName);
    if (!raw) return null;
    return maskSecrets(raw);
  }

  /** Load a toolkit config with raw (unmasked) values — internal use only. */
  private async loadConfigRaw(instanceName: string): Promise<ToolkitConfig | null> {
    return this.storage.get<ToolkitConfig>(NS_TOOLKIT_CONFIGS, instanceName);
  }

  /** List all saved toolkit configs (masked). */
  async listConfigs(): Promise<MaskedToolkitConfig[]> {
    const entries = await this.storage.list<ToolkitConfig>(NS_TOOLKIT_CONFIGS);
    return entries.map((e) => maskSecrets(e.value));
  }

  /** Update a toolkit config (partial). Secret fields are merged, not replaced when omitted. */
  async updateConfig(
    instanceName: string,
    updates: Partial<Pick<ToolkitConfig, "config" | "enabled">>,
  ): Promise<MaskedToolkitConfig> {
    const existing = await this.loadConfigRaw(instanceName);
    if (!existing) {
      throw new Error(`Toolkit config "${instanceName}" not found`);
    }

    const secretFields = getSecretFields(existing.toolkitId);
    const mergedConfig = { ...existing.config };

    if (updates.config) {
      for (const [key, value] of Object.entries(updates.config)) {
        if (secretFields.has(key) && typeof value === "string" && value.includes("*")) {
          continue;
        }
        mergedConfig[key] = value;
      }
    }

    const updated: ToolkitConfig = {
      ...existing,
      config: mergedConfig,
      enabled: updates.enabled ?? existing.enabled,
      updatedAt: new Date().toISOString(),
    };

    return this.saveConfig(updated);
  }

  /** Delete a toolkit config and remove its tools. */
  async deleteConfig(instanceName: string): Promise<boolean> {
    const existing = await this.loadConfigRaw(instanceName);
    if (!existing) return false;

    this.deactivate(instanceName);
    await this.storage.delete(NS_TOOLKIT_CONFIGS, instanceName);
    return true;
  }

  /* ── Instantiation ────────────────────────────────────────────── */

  /** Create a live toolkit instance from a config and add its tools. */
  private instantiate(cfg: ToolkitConfig): void {
    try {
      const tk = toolkitCatalog.create(cfg.toolkitId, cfg.config);
      this.liveToolkits.set(cfg.instanceName, tk);
      this.rebuildToolLibrary();
    } catch (error: any) {
      throw new Error(`Failed to instantiate toolkit "${cfg.instanceName}": ${error.message}`);
    }
  }

  /** Remove a live toolkit and its tools. */
  private deactivate(instanceName: string): void {
    if (this.liveToolkits.delete(instanceName)) {
      this.rebuildToolLibrary();
    }
  }

  /** Rebuild the merged tool library from all active toolkits. */
  private rebuildToolLibrary(): void {
    this.mergedToolLibrary = collectToolkitTools(Array.from(this.liveToolkits.values()));
  }

  /** Get the current tool library (all tools from active toolkits). */
  getToolLibrary(): Record<string, ToolDef> {
    return this.mergedToolLibrary;
  }

  /** Get all live toolkit instances. */
  getLiveToolkits(): Toolkit[] {
    return Array.from(this.liveToolkits.values());
  }

  /* ── Hydration ────────────────────────────────────────────────── */

  /**
   * Load all saved configs from storage and instantiate enabled ones.
   * Call once at startup.
   */
  async hydrate(): Promise<{ total: number; active: number; failed: string[] }> {
    const entries = await this.storage.list<ToolkitConfig>(NS_TOOLKIT_CONFIGS);
    let active = 0;
    const failed: string[] = [];

    for (const entry of entries) {
      if (entry.value.enabled) {
        try {
          this.instantiate(entry.value);
          active++;
        } catch {
          failed.push(entry.value.instanceName);
        }
      }
    }

    return { total: entries.length, active, failed };
  }
}
