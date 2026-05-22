export interface TenantContext {
  tenantId: string;
  metadata?: Record<string, unknown>;
}

export interface TenantConfig {
  required: boolean;
  isolation: "namespace" | "strict";
}
