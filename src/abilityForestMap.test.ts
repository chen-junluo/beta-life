import { describe, expect, it } from "vitest";
import { DEFAULT_ABILITY_FOREST } from "./defaults";
import { abilityMapCanMove, abilityMapLabelLines, generateAbilityMap } from "./abilityForestMap";
import { abilityNodeDisplayName, abilityNodePlainName, parseAbilityForestJson } from "./abilityForest";

describe("ability forest isometric map", () => {
  it("places every node deterministically and scales tree sizes by hierarchy", () => {
    const forest = structuredClone(DEFAULT_ABILITY_FOREST);
    const first = generateAbilityMap(forest, 42);
    const second = generateAbilityMap(forest, 42);
    expect(first.plants).toEqual(second.plants);
    expect(new Set(first.plants.map((plant) => plant.id))).toEqual(new Set(forest.nodes.map((node) => node.id)));
    expect(first.plants.filter((plant) => plant.size === 3)).toHaveLength(3);
    expect(first.plants.filter((plant) => plant.size === 2)).toHaveLength(9);
    expect(first.plants.filter((plant) => plant.size === 1)).toHaveLength(15);
    expect(first.land.length).toBeGreaterThan(500);
    expect(first.ocean.length).toBeGreaterThan(0);
  });

  it("rejects a dragged position that collides and preserves valid map positions in JSON", () => {
    const forest = structuredClone(DEFAULT_ABILITY_FOREST);
    const map = generateAbilityMap(forest, 42);
    const [first, second] = map.plants;
    expect(abilityMapCanMove(first, second.x, second.y, map.plants, map.gridSize)).toBe(false);
    const positioned = {
      ...forest,
      mapPositions: Object.fromEntries(map.plants.map((plant) => [plant.id, { x: plant.x, y: plant.y }])),
    };
    expect(parseAbilityForestJson(JSON.parse(JSON.stringify(positioned))).mapPositions).toEqual(positioned.mapPositions);
  });

  it("reads {px} font sizes per label line and falls back to the level size", () => {
    expect(abilityMapLabelLines("{15} AI native\n学者/实践者\n{40} 大\n{3} 小\n{12}", 1)).toEqual([
      { text: "AI native", fontSize: 15 },
      { text: "学者/实践者", fontSize: 10 },
      { text: "大", fontSize: 24 },
      { text: "小", fontSize: 6 },
      { text: "{12}", fontSize: 10 },
    ]);
    expect(abilityMapLabelLines("  \n", 0)).toEqual([{ text: "未命名节点", fontSize: 12 }]);
  });

  it("names outside the map drop {px}: first line for display, all lines for links", () => {
    expect(abilityNodeDisplayName("{15} AI native\n{9} 学者/实践者")).toBe("AI native");
    expect(abilityNodePlainName("{15} AI native\n{9} 学者/实践者")).toBe("AI native 学者/实践者");
    expect(abilityNodePlainName("宣发能力（建立IP）")).toBe("宣发能力（建立IP）");
  });
});
