import { describe, expect, it } from "vitest";
import {
  buildActionSpace,
  guessSearchQuery,
  isBlockedPageUrl,
  isBotChallengeText,
  isSearchResultsUrl,
  labelToAction,
  looksLikeResultList,
  searchUrl,
  titlesFromElements,
} from "../action-space.js";
import type { DomElement } from "../types.js";

function el(partial: Partial<DomElement> & Pick<DomElement, "index">): DomElement {
  return {
    cx: 10,
    cy: 10,
    role: "button",
    label: "Go",
    tag: "button",
    isInput: false,
    isSelect: false,
    isFile: false,
    ...partial,
  };
}

describe("searchUrl", () => {
  it("encodes the query for each engine", () => {
    expect(searchUrl("hello world")).toBe("https://html.duckduckgo.com/html/?q=hello%20world");
    expect(searchUrl("a+b", "google")).toBe("https://www.google.com/search?q=a%2Bb");
    expect(searchUrl("x", "bing")).toBe("https://www.bing.com/search?q=x");
  });
});

describe("guessSearchQuery", () => {
  it("prefers quoted text", () => {
    expect(guessSearchQuery(`Search for "TypeScript agents"`)).toBe("TypeScript agents");
  });

  it("strips search-for prefixes", () => {
    expect(guessSearchQuery("please search for flights NYC to London")).toBe("flights NYC to London");
  });
});

describe("buildActionSpace", () => {
  it("offers chrome plus click_N / type_N", () => {
    const space = buildActionSpace(
      [
        el({ index: 1, label: "Submit" }),
        el({ index: 2, label: "Email", isInput: true, role: "textbox", tag: "input" }),
      ],
      [],
    );
    expect(space.criteria.back).toBeDefined();
    expect(space.criteria.search).toBeDefined();
    expect(space.criteria.click_1).toContain("Submit");
    expect(space.criteria.click_2).toContain("Email");
    expect(space.criteria.type_2).toContain("Email");
    expect(space.criteria.type_1).toBeUndefined();
  });

  it("caps DOM choices at max", () => {
    const elements = Array.from({ length: 5 }, (_, i) => el({ index: i + 1, label: `B${i}` }));
    const space = buildActionSpace(elements, [], { max: 2 });
    expect(space.criteria.click_1).toBeDefined();
    expect(space.criteria.click_2).toBeDefined();
    expect(space.criteria.click_3).toBeUndefined();
  });

  it("omits scroll when the page fits the viewport", () => {
    const space = buildActionSpace([], [], { pagesBelow: 0, pagesAbove: 0 });
    expect(space.criteria.scroll_down).toBeUndefined();
    expect(space.criteria.scroll_up).toBeUndefined();
  });

  it("offers switch/close for extra tabs", () => {
    const space = buildActionSpace(
      [],
      [
        { id: "tab-1", url: "https://a.com", active: true },
        { id: "tab-2", url: "https://b.com", active: false },
      ],
    );
    expect(space.criteria["switch_tab_tab-2"]).toContain("tab-2");
    expect(space.criteria["close_tab_tab-1"]).toBeDefined();
    expect(space.criteria["switch_tab_tab-1"]).toBeUndefined();
  });

  it("omits search after a search already ran", () => {
    const space = buildActionSpace([], [], { allowSearch: false });
    expect(space.criteria.search).toBeUndefined();
    expect(space.criteria.done).toBeDefined();
  });

  it("omits done until real result titles exist", () => {
    const space = buildActionSpace([], [], { allowDone: false });
    expect(space.criteria.done).toBeUndefined();
  });

  it("omits wait after one wait already ran", () => {
    const space = buildActionSpace([], [], { allowWait: false });
    expect(space.criteria.wait).toBeUndefined();
  });
});

describe("page URL helpers", () => {
  it("detects SERP and bot-block URLs", () => {
    expect(isSearchResultsUrl("https://html.duckduckgo.com/html/?q=cats")).toBe(true);
    expect(isSearchResultsUrl("https://www.google.com/search?q=cats")).toBe(true);
    expect(isSearchResultsUrl("https://example.com")).toBe(false);
    expect(isBlockedPageUrl("https://duckduckgo.com/static-pages/home-error/418.html?bno=1")).toBe(true);
    expect(isBlockedPageUrl("https://html.duckduckgo.com/html/?q=cats")).toBe(false);
    expect(isBotChallengeText("Unfortunately, bots use DuckDuckGo too.")).toBe(true);
    expect(isBotChallengeText("TypeScript: JavaScript With Syntax For Types.")).toBe(false);
  });

  it("skips chrome links like email us and keeps long result titles", () => {
    const text = titlesFromElements([
      el({ index: 1, tag: "a", role: "link", label: "email us" }),
      el({ index: 2, tag: "a", role: "link", label: "Privacy" }),
      el({ index: 3, tag: "a", role: "link", label: "Building a TypeScript agent framework in 2026" }),
      el({ index: 4, tag: "a", role: "link", label: "LangChain agents tutorial for TypeScript" }),
    ]);
    expect(text).not.toContain("email us");
    expect(text).toContain("Building a TypeScript agent framework in 2026");
    expect(text).toContain("LangChain agents tutorial for TypeScript");
    expect(looksLikeResultList(text)).toBe(true);
    expect(looksLikeResultList("1. email us")).toBe(false);
  });
});

describe("labelToAction", () => {
  it("maps chrome and indexed labels", () => {
    expect(labelToAction("back")).toEqual({ action: "back" });
    expect(labelToAction("scroll_down")).toEqual({ action: "scroll", direction: "down" });
    expect(labelToAction("click_12")).toEqual({ action: "click", index: 12 });
    expect(labelToAction("type_3", { typeText: "hi" })).toEqual({ action: "type", index: 3, text: "hi" });
    expect(labelToAction("search", { searchQuery: "cats" })).toEqual({ action: "search", query: "cats" });
    expect(labelToAction("switch_tab_tab-2")).toEqual({ action: "switch_tab", tabId: "tab-2" });
    expect(labelToAction("close_tab_tab-1")).toEqual({ action: "close_tab", tabId: "tab-1" });
    expect(labelToAction("done", { doneResult: "ok" })).toEqual({ action: "done", result: "ok" });
    expect(labelToAction("none")).toBeUndefined();
  });
});
