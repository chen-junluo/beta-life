import { describe, expect, it } from "vitest";
import type { LifeStage, MemoryMetadata } from "./types";
import { buildEmotionYearTable, getSimilarMemoryGroups, matchesSongQuery, memoryHasLocation, memoryStarSize, memoryYear, songMatchScore, splitMemoryLocations } from "./memoryLogic";

const stages: LifeStage[] = [
  { name: "School", start: "2010-09", end: "2014-06" },
  { name: "Work", start: "2014-07", end: "2018-06" },
];

function memory(id: string, patch: Partial<MemoryMetadata> = {}): MemoryMetadata {
  return {
    id,
    song: id,
    date: "2012Q2",
    stage: "School",
    location: "Home",
    emotion: { type: "calm", intensity: 5 },
    createdAt: "",
    updatedAt: "",
    ...patch,
  };
}

describe("memory visual data", () => {
  it("splits multi-location values while preserving legacy single locations", () => {
    expect(splitMemoryLocations("校园, 上海 / 东京、校园")).toEqual(["校园", "上海", "东京"]);
    expect(memoryHasLocation("校园, 上海", "上海")).toBe(true);
    expect(memoryHasLocation("校园, 上海", "北京")).toBe(false);
  });

  it("matches partial song queries after normalizing case, width, and spaces", () => {
    expect(matchesSongQuery("晴天", "晴")).toBe(true);
    expect(matchesSongQuery("ＡＢＣ 之歌", "abc之")).toBe(true);
    expect(matchesSongQuery("南山南", "北山")).toBe(false);
    expect(matchesSongQuery("南山南", "   ")).toBe(true);
  });

  it("fuzzy-matches in-order characters and ranks contiguous matches first", () => {
    expect(matchesSongQuery("夜空中最亮的星", "夜星")).toBe(true);
    expect(matchesSongQuery("夜空中最亮的星", "星夜")).toBe(false);
    expect(matchesSongQuery("Viva La Vida", "vlv")).toBe(true);
    const contiguous = songMatchScore("晴天", "晴天") ?? -1;
    const prefixed = songMatchScore("我的晴天", "晴天") ?? -1;
    const scattered = songMatchScore("晴朗的天", "晴天") ?? -1;
    expect(contiguous).toBeGreaterThan(prefixed);
    expect(prefixed).toBeGreaterThan(scattered);
  });

  it("matches Chinese titles by pinyin initials and full pinyin", () => {
    expect(matchesSongQuery("七里香", "qlx")).toBe(true);
    expect(matchesSongQuery("夜空中最亮的星", "YKZ")).toBe(true);
    expect(matchesSongQuery("晴天", "qingtian")).toBe(true);
    expect(matchesSongQuery("重庆森林", "cqsl")).toBe(true);
    expect(matchesSongQuery("晴天", "xyz")).toBe(false);
    expect((songMatchScore("晴天", "晴") ?? -1)).toBeGreaterThan(songMatchScore("晴天", "qt") ?? -1);
  });
  it("maps quarter and exact dates to years and omits fuzzy dates", () => {
    expect(memoryYear("2021Q2")).toBe(2021);
    expect(memoryYear("20220102")).toBe(2022);
    expect(memoryYear("high school summer")).toBeNull();
  });

  it("maps different emotion intensities to different star sizes using the constellation formula", () => {
    const low = memoryStarSize(0, 2, 2);
    const high = memoryStarSize(10, 2, 2);
    expect(low).toBeCloseTo(2 + 2 * ((0 - 1) / 9));
    expect(high).toBeCloseTo(2 + 2 * ((10 - 1) / 9));
    expect(high).toBeGreaterThan(low);
  });

  it("counts only the supplied filtered memories across stage years", () => {
    const table = buildEmotionYearTable([
      memory("one", { date: "2012Q2" }),
      memory("two", { date: "2012-11-03", emotion: { type: "warm", intensity: 8 } }),
    ], stages);

    expect(table.years).toEqual([2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018]);
    expect(table.counts.calm[2]).toBe(1);
    expect(table.counts.warm[2]).toBe(1);
    expect(table.datedMemoryCount).toBe(2);
  });

  it("keeps V11 recommendation order and limits each group to five distinct song names", () => {
    const selected = memory("selected", { song: "Selected", location: "Home", emotion: { type: "calm", intensity: 5 } });
    const memories = [
      selected,
      ...Array.from({ length: 7 }, (_, index) => memory(`home-${index}`, { song: `Home ${index}`, location: "Home" })),
      memory("same-song", { song: "Selected", location: "Home" }),
    ];

    const groups = getSimilarMemoryGroups(memories, selected);
    expect(groups.sameLocation.map(({ id }) => id)).toEqual(["home-0", "home-1", "home-2", "home-3", "home-4"]);
    expect(groups.sameEmotion).toHaveLength(5);
    expect(groups.sameStage).toHaveLength(5);
  });

  it("recommends memories that share any split location", () => {
    const selected = memory("selected", { location: "Home, Office" });
    const groups = getSimilarMemoryGroups([
      selected,
      memory("office", { location: "Office / Cafe" }),
      memory("remote", { location: "Remote" }),
    ], selected);
    expect(groups.sameLocation.map(({ id }) => id)).toEqual(["office"]);
  });
});
