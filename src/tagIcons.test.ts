import { describe, expect, it } from "vitest";
import { TAG_ICON_CHOICES, assignTagIcons, tagIcon } from "./tagIcons";

describe("tag icons", () => {
  it("keeps chosen icons, including an explicit no-icon choice", () => {
    const icons = { 饮食: "🍵", 睡不着: "" };
    expect(assignTagIcons(icons, ["饮食", "睡不着"])).toBe(icons);
    expect(tagIcon(icons, "饮食")).toBe("🍵");
    expect(tagIcon(icons, "睡不着")).toBe("");
    expect(tagIcon(icons, "constructor")).toBe("");
  });

  it("gives new tags distinct defaults without touching existing ones", () => {
    const tags = ["调理温湿", "大饱觉神功", "道家修心与养生", "饮食", "口才突破", "睡不着"];
    const icons = assignTagIcons({ 饮食: "🍵" }, tags);
    expect(icons.饮食).toBe("🍵");
    expect(new Set(tags.map((tag) => icons[tag])).size).toBe(tags.length);
    tags.forEach((tag) => expect(TAG_ICON_CHOICES).toContain(icons[tag]));

    const withNewTag = assignTagIcons(icons, [...tags, "新习惯"]);
    tags.forEach((tag) => expect(withNewTag[tag]).toBe(icons[tag]));
    expect(Object.values(icons)).not.toContain(withNewTag.新习惯);
  });

  it("is deterministic for the same tag", () => {
    expect(assignTagIcons({}, ["饮食"])).toEqual(assignTagIcons({}, ["饮食"]));
  });
});
