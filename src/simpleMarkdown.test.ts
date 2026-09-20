import { describe, expect, it } from "vitest";
import { parseSimpleMarkdown, splitTags } from "./simpleMarkdown";

describe("parseSimpleMarkdown", () => {
  it("keeps plain title line breaks and groups basic lists", () => {
    expect(parseSimpleMarkdown("提醒\n- 喝水\n- 拉伸\n1. 记录\n2. 复盘")).toEqual([
      { kind: "text", lines: ["提醒"] },
      { kind: "unordered-list", items: ["喝水", "拉伸"] },
      { kind: "ordered-list", items: ["记录", "复盘"] },
    ]);
  });
});

describe("splitTags", () => {
  it("accepts common Chinese and English separators", () => {
    expect(splitTags("#健康, 每天；低强度 / 睡前")).toEqual(["健康", "每天", "低强度", "睡前"]);
  });
});
