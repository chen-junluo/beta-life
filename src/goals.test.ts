import { describe, expect, it } from "vitest";
import { DEFAULT_ABILITY_FOREST } from "./defaults";
import { entriesByPath, goalStatus, goalsMessage, namePaths, staleGoals, type GoalEntry } from "./goals";

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
    expect(goalStatus([], now, 7)).toEqual({ label: "还没推进", stale: false, monthDays: 0 });
    expect(goalStatus([], now, 7, "2026-11-07")).toEqual({ label: "还没推进", stale: false, monthDays: 0 });
    expect(goalStatus([], now, 7, "2026-11-06")).toEqual({ label: "标记 7 天还没推进", stale: true, monthDays: 0 });
    expect(goalStatus([entry("2026-11-13"), entry("2026-11-13"), entry("2026-10-30")], now, 7)).toEqual({ label: "今天", stale: false, monthDays: 1 });
    expect(goalStatus([entry("2026-11-10")], now, 7)).toEqual({ label: "3 天前", stale: false, monthDays: 1 });
    expect(goalStatus([entry("2026-11-06")], now, 7).label).toBe("7 天没推进");
    expect(goalStatus([entry("2026-11-10")], now, 3)).toEqual({ label: "3 天没推进", stale: true, monthDays: 1 });
  });

  it("lists stale goals longest idle first, counting new goals from the day they were marked", () => {
    const now = new Date(2026, 10, 13, 8, 0);
    const goal = (name: string, since: string) => ({ map: "vision" as const, path: ["领域", name], name, link: `领域#${name}`, since });
    const progress = {
      goals: [goal("目标", "2026-10-01"), goal("新目标", "2026-11-10"), goal("旧目标", "2026-10-20"), goal("最近", "2026-10-01")],
      entries: [entry("2026-11-01"), entry("2026-10-25"), { ...entry("2026-11-12"), path: ["领域", "最近"] }, { ...entry("2026-10-01"), map: "research" as const, path: ["领域", "旧目标"] }],
    };
    expect(staleGoals(progress, now, 7).map((item) => [item.name, item.label, item.days])).toEqual([
      ["旧目标", "标记 24 天还没推进", 24],
      ["目标", "12 天没推进", 12],
    ]);
    expect(staleGoals(progress, now, 7)[0].key).toBe("vision:领域\u001f旧目标");
  });

  it("sorts one map's entries newest first and writes the summary's goal list", () => {
    const grouped = entriesByPath({ goals: [], entries: [entry("2026-11-10", "a"), entry("2026-11-12", "b"), { ...entry("2026-11-12"), map: "research" }] }, "vision");
    expect([...grouped.values()][0].map((item) => item.text)).toEqual(["b", "a"]);
    expect(goalsMessage([])).toBe("");
    expect(goalsMessage([{ map: "vision", path: ["研究者", "论文"], name: "论文", link: "研究者#论文", since: "2026-11-01" }])).toContain("- [[研究者#论文]]（研究者 › 论文）");
  });
});
