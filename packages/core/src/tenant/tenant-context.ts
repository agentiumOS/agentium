import type { TenantConfig, TenantContext } from "./types.js";

export function withTenant(tenantId: string, metadata?: Record<string, unknown>): TenantContext {
  return { tenantId, metadata };
}

export function requireTenant(tenantId: string | undefined, config: TenantConfig): string {
  if (config.required && !tenantId) {
    throw new Error("Tenant ID is required but was not provided. Pass tenantId in RunOpts or request headers.");
  }
  return tenantId ?? "";
}

export function extractTenantFromHeaders(headers: Record<string, string | string[] | undefined>): string | undefined {
  const value = headers["x-tenant-id"] ?? headers["X-Tenant-Id"];
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

export function extractTenantFromJwt(claims: Record<string, unknown>): string | undefined {
  return (claims.tenantId ?? claims.tenant_id ?? claims.org_id ?? claims.organization_id) as string | undefined;
}
