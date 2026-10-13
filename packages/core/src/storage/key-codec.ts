import type { StorageScope } from "./scoped.js";

/** Versioned namespace identity; null distinguishes absent scope IDs from empty IDs. */
export function encodeScopeNamespace(namespace: string, scope: StorageScope): string {
  return JSON.stringify(["agentium-storage-scope-v1", scope.tenantId ?? null, scope.userId ?? null, namespace]);
}

/** Encodes exact JS strings into glob-safe, prefix-preserving UTF-16 segments. */
export function encodeKeySegment(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index++) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

export function decodeKeySegment(encoded: string): string {
  if (encoded.length % 4 || !/^[0-9a-f]*$/.test(encoded)) {
    throw new TypeError("Invalid storage key encoding");
  }
  let value = "";
  for (let index = 0; index < encoded.length; index += 4) {
    value += String.fromCharCode(Number.parseInt(encoded.slice(index, index + 4), 16));
  }
  return value;
}
