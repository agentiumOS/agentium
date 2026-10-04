import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { BrowserProvider } from "../browser-provider.js";

// Execute the real injected extractor against DOM-shaped fixtures, including
// shadow roots. No live browser, credentials or provider is required.
function extract(
  fields: Array<{ tag: string; type?: string; text?: string; value?: string; label?: string; editable?: boolean }>,
) {
  const nodes = fields.map((field, index) => ({
    tagName: field.tag.toUpperCase(),
    innerText: field.text ?? "",
    textContent: field.text ?? "",
    value: field.value ?? "",
    isContentEditable: field.editable ?? false,
    getAttribute: (name: string) => ({ type: field.type, "aria-label": field.label })[name],
    setAttribute() {},
    removeAttribute() {},
    contains(other: unknown) {
      return other === this;
    },
    getBoundingClientRect: () => ({
      width: 100,
      height: 20,
      left: 0,
      right: 100,
      top: index * 30,
      bottom: index * 30 + 20,
    }),
  }));
  const document = {
    querySelectorAll: (selector: string) => (selector === "[data-bua-idx]" ? [] : nodes),
    elementFromPoint: (_x: number, y: number) => nodes[Math.floor(y / 30)],
    body: { scrollTop: 0, scrollHeight: 500 },
  };
  const window = {
    innerWidth: 800,
    innerHeight: 500,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", cursor: "auto" }),
  };
  const provider = new BrowserProvider();
  const script = (provider as unknown as { extractorScriptSource(): string }).extractorScriptSource();
  return runInNewContext(`${script}; window.__buaExtract(200, 0, 0, 'main')`, { window, document });
}

describe("DOM input observation redaction", () => {
  it("never uses filled password, OTP, payment or text values as labels", () => {
    const snapshot = extract([
      { tag: "input", type: "password", value: "private-password" },
      { tag: "input", type: "text", value: "private-otp" },
      { tag: "textarea", text: "private-card", value: "private-card" },
      { tag: "div", editable: true, text: "private-editable" },
      { tag: "input", type: "password", label: "Account password", value: "private-secret" },
    ]);
    expect(snapshot.elements).toHaveLength(5);
    expect(JSON.stringify(snapshot)).not.toContain("private-");
    expect(snapshot.elements[4].label).toBe("Account password");
  });

  it("retains noneditable control text and locations", () => {
    const snapshot = extract([{ tag: "button", text: "Continue" }]);
    expect(snapshot.elements[0]).toMatchObject({ label: "Continue", index: 1, cx: 50, cy: 10 });
  });
});
