import { describe, expect, it } from "vitest";
import { decodeKeySegment, encodeKeySegment, encodeScopeNamespace } from "../key-codec.js";

describe("internal storage key codec", () => {
  it.each([
    ["", ""],
    [":*?[]\\", "003a002a003f005b005d005c"],
    ["雪😀", "96ead83dde00"],
    ["\ud800", "d800"],
    ["\udfff", "dfff"],
  ])("preserves exact UTF-16 identity for %j", (value, encoded) => {
    expect(encodeKeySegment(value)).toBe(encoded);
    expect(decodeKeySegment(encoded)).toBe(value);
  });

  it.each(["0", "abcde", "zzzz", "ABCD", "000g", "0000:"])("rejects malformed physical segment %j", (encoded) => {
    expect(() => decodeKeySegment(encoded)).toThrow(TypeError);
  });

  it("keeps absent, empty and delimiter-bearing tuple fields explicit", () => {
    expect(encodeScopeNamespace("n:s", {})).toBe('["agentium-storage-scope-v1",null,null,"n:s"]');
    expect(encodeScopeNamespace("n:s", { tenantId: "", userId: "a:b" })).toBe(
      '["agentium-storage-scope-v1","","a:b","n:s"]',
    );
  });
});
