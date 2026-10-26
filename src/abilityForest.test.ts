import { describe, expect, it } from "vitest";
import {
  deleteAbilityNode,
  moveAbilityNode,
  orderedSiblings,
  parseAbilityForestJson,
  reorderAbilityNode,
  validateAbilityForest,
} from "./abilityForest";
import { DEFAULT_ABILITY_FOREST } from "./defaults";

describe("ability forest editing", () => {
  it("loads the complete three-level tree from the v4.3 prototype", () => {
    expect(validateAbilityForest(DEFAULT_ABILITY_FOREST).nodes).toHaveLength(27);
    expect(DEFAULT_ABILITY_FOREST.nodes.find((node) => node.id === "data-analysis")).toMatchObject({
      parentId: "data-literacy",
      level: 2,
    });
  });

  it("moves a branch to a new parent and keeps its descendants connected", () => {
    const moved = moveAbilityNode(DEFAULT_ABILITY_FOREST, "engineering", "expression");

    expect(moved.nodes.find((node) => node.id === "engineering")).toMatchObject({ parentId: "expression", level: 1 });
    expect(moved.nodes.find((node) => node.id === "api-design")).toMatchObject({ parentId: "engineering", level: 2 });
    expect(orderedSiblings(moved, "technology").map((node) => node.id)).toEqual(["product-design", "data-literacy"]);
  });

  it("reorders siblings and normalizes their persisted positions", () => {
    const reordered = reorderAbilityNode(DEFAULT_ABILITY_FOREST, "data-literacy", -1);

    expect(orderedSiblings(reordered, "technology").map((node) => node.id)).toEqual([
      "engineering",
      "data-literacy",
      "product-design",
    ]);
    expect(orderedSiblings(reordered, "technology").map((node) => node.order)).toEqual([0, 1, 2]);
  });

  it("deletes the selected node's whole branch while retaining other groups", () => {
    const withoutProductDesign = deleteAbilityNode(DEFAULT_ABILITY_FOREST, "product-design");

    expect(withoutProductDesign.nodes.some((node) => node.id === "user-research")).toBe(false);
    expect(withoutProductDesign.nodes.some((node) => node.id === "product-structure")).toBe(false);
    expect(withoutProductDesign.nodes.some((node) => node.id === "data-literacy")).toBe(true);
    expect(withoutProductDesign.nodes).toHaveLength(24);
  });

  it("rejects moves into a node's descendant and imports nested prototype JSON", () => {
    expect(() => moveAbilityNode(DEFAULT_ABILITY_FOREST, "technology", "data-literacy")).toThrow("自己的子树");

    const imported = parseAbilityForestJson({
      nodes: [{ id: "root", name: "领域", md: "# 领域", children: [
        { id: "group", name: "组", md: "说明", children: [{ id: "skill", name: "能力", md: "细节", children: [] }] },
      ] }],
    });
    expect(imported.nodes.map(({ id, parentId, level }) => [id, parentId, level])).toEqual([
      ["root", null, 0],
      ["group", "root", 1],
      ["skill", "group", 2],
    ]);
    expect(imported.nodes[2].markdown).toBe("细节");
  });

  it("imports persisted map view state with the forest", () => {
    const imported = parseAbilityForestJson({
      nodes: [{ id: "root", name: "根", level: 0, parentId: null, order: 0, color: "#7FB77E", markdown: "" }],
      mapState: {
        seed: 77,
        zoom: 1.2,
        pan: { x: 24, y: -12 },
        visibleLevels: 2,
        options: { baseRadius: 25, clusterSpread: 9, largeNodeRadius: 8, mediumNodeRadius: 14 },
        selectedId: "root",
      },
    });
    expect(imported.mapState).toMatchObject({ seed: 77, zoom: 1.2, pan: { x: 24, y: -12 }, selectedId: "root" });
  });
});
