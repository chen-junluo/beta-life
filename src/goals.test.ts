import { describe, expect, it } from "vitest";
import { DEFAULT_ABILITY_FOREST } from "./defaults";
import { entriesByPath, goalStatus, goalsMessage, namePaths, type GoalEntry } from "./goals";

const entry = (date: string, text = ""): GoalEntry => ({ map: "vision", path: ["领域", "目标"], date, text });

describe("goals", () => {
  it("numbers repeated sibling names like the Rust side", () => {
    const forest = structuredClone(DEFAULT_ABILITY_FOREST);
    const twin = { ...forest.nodes.find((node) => node.id === "engineering")!, id: "twin", order: 99 };
    forest.nodes.push(twin);
    const paths = namePaths(forest);
    expect(paths.get("engineering")).toEqual(["技术与产品", "软件工程"]);
    expect(paths.get("twin")).toEqual(["技术与产品", "软件工程#2"]);
    expect(paths.get("api-design")).toEqual(["技术与产品", "软件工程", "接口设计"]);
  });

  it("labels the latest progress and counts this month's days", () => {
    const now = new Date(2026, 10, 13, 21, 0);
    expect(goalStatus([], now)).toEqual({ label: "还没推进", stale: true, monthDays: 0 });
    expect(goalStatus([entry("2026-11-13"), entry("2026-11-13"), entry("2026-10-30")], now)).toEqual({ label: "今天", stale: false, monthDays: 1 });
    expect(goalStatus([entry("2026-11-10")], now)).toEqual({ label: "3 天前", stale: false, monthDays: 1 });
    expect(goalStatus([entry("2026-11-06")], now).label).toBe("7 天没推进");
  });

  it("sorts one map's entries newest first and writes the summary's goal list", () => {
    const grouped = entriesByPath({ goals: [], entries: [entry("2026-11-10", "a"), entry("2026-11-12", "b"), { ...entry("2026-11-12"), map: "research" }] }, "vision");
    expect([...grouped.values()][0].map((item) => item.text)).toEqual(["b", "a"]);
    expect(goalsMessage([])).toBe("");
    expect(goalsMessage([{ map: "vision", path: ["研究者", "论文"], name: "论文", link: "研究者#论文" }])).toContain("- [[研究者#论文]]（研究者 › 论文）");
  });
});
