import { describe, expect, it } from "vitest";
import { appendToBody, bodyProblem, codeDate, dayCode, dayLabel, dayPreview, dayTitle, headingDate, monthList, monthTitle, newDayBody } from "./diaryLogic";

describe("diary logic", () => {
  it("names days the way the diary writes them", () => {
    expect(dayCode(new Date(2026, 10, 11))).toBe("261111");
    expect(dayLabel("261111")).toBe("261111周三");
    expect(dayLabel("261005")).toBe("261005周一");
    expect(codeDate("260231")).toBeNull();
    expect(monthTitle("2611")).toBe("2026 年 11 月");
    expect(monthList(["2610", "2607"], "2611")).toEqual(["2607", "2610", "2611"]);
    expect(headingDate("## 260904 周五")).toBe("260904");
    expect(headingDate("- 261111周三")).toBeNull();
  });

  it("fills the template body", () => {
    expect(newDayBody("- ", "261111")).toBe("- ");
    expect(newDayBody("{{date}} 的计划\n- ", "261111")).toBe("261111周三 的计划\n- ");
  });

  it("reads titles and previews", () => {
    expect(dayTitle({ id: "261005", date: "261005", title: "261005周一", body: "" })).toBe("261005周一");
    expect(dayTitle({ id: "preamble", date: null, title: "", body: "月初的想法" })).toBe("月初");
    expect(dayPreview("\n- **早起**\n\t- 跑步")).toBe("早起");
    expect(dayPreview("### 小标题\n正文")).toBe("小标题");
  });

  it("refuses a body that holds another day heading", () => {
    expect(bodyProblem("- a\n\n一段话\n\n### 小标题")).toBeNull();
    expect(bodyProblem("- a\n\n## 261112周四")).toContain("日期标题");
  });

  it("appends to the end of a body", () => {
    expect(appendToBody("- ", "- 散步\n\t- 30 分钟\n")).toBe("- 散步\n\t- 30 分钟");
    expect(appendToBody("- 读书", "- 散步")).toBe("- 读书\n- 散步");
    expect(appendToBody("一段话", "- 散步")).toBe("一段话\n\n- 散步");
    expect(appendToBody("- 读书", "补一句")).toBe("- 读书\n\n补一句");
  });
});
