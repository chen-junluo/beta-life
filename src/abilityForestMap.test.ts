import { describe, expect, it } from "vitest";
import { DEFAULT_ABILITY_FOREST } from "./defaults";
import { abilityMapCanMove, generateAbilityMap } from "./abilityForestMap";
import { parseAbilityForestJson } from "./abilityForest";

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
});
