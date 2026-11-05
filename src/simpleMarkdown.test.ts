import { describe, expect, it } from "vitest";
import { applyTagSuggestion, collectTags, parseSimpleMarkdown, splitTags, suggestTags, tagUsage } from "./simpleMarkdown";

describe("parseSimpleMarkdown", () => {
  it("keeps plain title line breaks and groups basic lists", () => {
    expect(parseSimpleMarkdown("提醒\n- 喝水\n- 拉伸\n1. 记录\n2. 复盘")).toEqual([
      { kind: "text", lines: ["提醒"] },
      { kind: "unordered-list", items: ["喝水", "拉伸"] },
      { kind: "ordered-list", items: ["记录", "复盘"] },
    ]);
  });

  it("parses headings as structured blocks", () => {
    expect(parseSimpleMarkdown("## 核心概念")).toEqual([{ kind: "heading", level: 2, text: "核心概念" }]);
  });
});

describe("splitTags", () => {
  it("accepts common Chinese and English separators", () => {
    expect(splitTags("#健康, 每天；低强度 / 睡前")).toEqual(["健康", "每天", "低强度", "睡前"]);
  });
});

describe("tag suggestions", () => {
  const known = collectTags(["饮食, 调理温湿", "调理温湿", "#口才突破", "道家修心与养生, 调理温湿"]);

  it("orders known tags by usage", () => {
    expect(known).toEqual(["调理温湿", "饮食", "口才突破", "道家修心与养生"]);
  });

  it("counts each habit once per tag", () => {
    expect(tagUsage(["饮食, 饮食", "饮食"])).toEqual([{ tag: "饮食", count: 2 }]);
  });

  it("matches the tag being typed and skips tags already entered", () => {
    expect(suggestTags("饮食，调", known)).toEqual(["调理温湿"]);
    expect(suggestTags("调理温湿, ", known)).toEqual(["饮食", "口才突破", "道家修心与养生"]);
    expect(suggestTags("#口", known)).toEqual(["口才突破"]);
  });

  it("replaces only the tag being typed", () => {
    expect(applyTagSuggestion("饮食，调", "调理温湿")).toBe("饮食，调理温湿, ");
    expect(applyTagSuggestion("饮食, 调", "调理温湿")).toBe("饮食, 调理温湿, ");
    expect(applyTagSuggestion("口", "口才突破")).toBe("口才突破, ");
  });
});
