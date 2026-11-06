import { describe, expect, it } from "vitest";
import { collectTags, splitTags, tagUsage } from "./simpleMarkdown";

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
});
