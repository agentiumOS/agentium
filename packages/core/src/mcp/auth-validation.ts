/**
 * MCP 2026-07-28 authorization-conformance helpers.
 *
 * Covers:
 *  - RFC 9207 `iss` parameter validation (SEP-2468) to prevent OAuth mix-up attacks
 *  - OpenID Connect Dynamic Client Registration `application_type` selection
 *  - Issuer re-registration helpers (SEP-2352)
 *
 * Designed to be invoked by callers that drive the MCP OAuth flow themselves;
 * the `@modelcontextprotocol/sdk` exposes the necessary hooks.
 */

export class MCPAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MCPAuthError";
  }
}

/**
 * Validate the `iss` parameter on an OAuth authorization response per
 * [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html) using simple string
 * comparison (RFC 3986 §6.2.1).
 *
 * Per SEP-2468 (MCP 2026-07-28), MCP clients MUST validate `iss` when an
 * authorization server advertises support. Pass the issuer recorded at the
 * start of the flow as `expectedIssuer`.
 *
 * @throws MCPAuthError on mismatch
 */
export function validateAuthIssuer(receivedIss: string | undefined, expectedIssuer: string): void {
  if (!receivedIss) {
    throw new MCPAuthError(
      `MCP authorization response is missing the 'iss' parameter (expected ${expectedIssuer}). ` +
        "Reject responses without an iss when the authorization server advertises support.",
    );
  }
  if (receivedIss !== expectedIssuer) {
    throw new MCPAuthError(
      `MCP authorization-server mix-up detected: received iss=${receivedIss}, expected ${expectedIssuer}.`,
    );
  }
}

/**
 * Returns true when the AS metadata advertises iss support (`authorization_response_iss_parameter_supported`).
 */
export function authorizationServerSupportsIss(asMetadata: Record<string, unknown> | null | undefined): boolean {
  return Boolean(asMetadata?.authorization_response_iss_parameter_supported);
}

/**
 * Pick the `application_type` to send during OpenID Connect Dynamic Client
 * Registration (SEP-837). Servers default unknown clients to `"web"` which
 * rejects localhost redirect URIs on desktop / CLI clients.
 *
 * Returns `"native"` for processes that use localhost redirects (CLIs,
 * background workers, edge functions); `"web"` otherwise.
 */
export function pickOidcApplicationType(opts: {
  /** Will the client receive its redirect at a localhost URL? */
  usesLocalhostRedirect?: boolean;
  /** Override - returns this regardless of heuristics. */
  override?: "native" | "web";
}): "native" | "web" {
  if (opts.override) return opts.override;
  return opts.usesLocalhostRedirect ? "native" : "web";
}

/**
 * Detect when registered client credentials need to be re-issued because the
 * resource has been migrated to a new authorization server (SEP-2352). Compare
 * the issuer recorded with the credentials against the issuer of the current
 * resource server's metadata.
 *
 * Returns true when re-registration is required.
 */
export function needsReRegistration(
  recordedIssuer: string | null | undefined,
  currentIssuer: string | null | undefined,
): boolean {
  if (!recordedIssuer || !currentIssuer) return true;
  return recordedIssuer !== currentIssuer;
}
