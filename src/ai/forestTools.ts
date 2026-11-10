import { createAbilityNode, deleteAbilityNode, moveAbilityNode, orderedSiblings, renameAbilityNode, setAbilityNodeColor, updateAbilityMarkdown } from "../abilityForest";
import { DEFAULT_ABILITY_MAP_NAMES } from "../defaults";
import type { AbilityForest, AbilityMapKind, AbilityNode } from "../types";
import type { AiChange, ChangeKind } from "./types";

export type Forests = Record<AbilityMapKind, AbilityForest>;
type ChangeInput = Pick<AiChange, "name" | "arguments" | "createdId">;

const LEVEL_LABELS = ["领域", "能力组", "能力"];
const MAP_KINDS: AbilityMapKind[] = ["vision", "research"];

export function mapName(forest: AbilityForest, map: AbilityMapKind): string {
  return forest.name?.trim() || DEFAULT_ABILITY_MAP_NAMES[map];
}

function mapOf(args: AiChange["arguments"]): AbilityMapKind {
  if (args.map !== "vision" && args.map !== "research") throw new Error("map must be vision or research");
  return args.map;
}

function findNode(forest: AbilityForest, id: unknown): AbilityNode {
  const node = forest.nodes.find((item) => item.id === id);
  if (!node) throw new Error(`No node with id "${String(id)}" in this map`);
  return node;
}

/** Nodes in tree order (parents before children, siblings by order). */
function treeOrder(forest: AbilityForest): AbilityNode[] {
  const result: AbilityNode[] = [];
  const visit = (parentId: string | null) => orderedSiblings(forest, parentId).forEach((node) => {
    result.push(node);
    visit(node.id);
  });
  visit(null);
  return result;
}

function subtreeSize(forest: AbilityForest, id: string): number {
  return 1 + orderedSiblings(forest, id).reduce((sum, child) => sum + subtreeSize(forest, child.id), 0);
}

export function forestMapIndex(forest: AbilityForest, map: AbilityMapKind) {
  return {
    map,
    name: mapName(forest, map),
    nodes: treeOrder(forest).map((node) => ({
      id: node.id,
      name: node.name,
      level: node.level,
      parentId: node.parentId,
      order: node.order,
      hasNote: node.markdown.trim().length > 0,
    })),
  };
}

export function forestIndex(forests: Forests) {
  return { maps: MAP_KINDS.map((map) => forestMapIndex(forests[map], map)) };
}

export function readNode(forests: Forests, args: AiChange["arguments"]) {
  const node = findNode(forests[mapOf(args)], args.id);
  return { id: node.id, name: node.name, level: node.level, parentId: node.parentId, markdown: node.markdown };
}

/** Applies one forest write. Structural changes reset dragged positions, matching manual edits. */
export function applyForestChange(forests: Forests, change: ChangeInput): Forests {
  const args = change.arguments;
  const map = mapOf(args);
  const forest = forests[map];
  let next: AbilityForest;
  switch (change.name) {
    case "add_node": {
      if (!change.createdId) throw new Error("add_node needs an id");
      const parentId = typeof args.parentId === "string" && args.parentId ? args.parentId : null;
      const created = createAbilityNode(forest, parentId);
      const name = String(args.name).trim();
      const markdown = typeof args.markdown === "string" ? args.markdown : `# ${name}\n\n写下这个节点的说明。`;
      const nodes = created.nodes.map((node, index) => (index === created.nodes.length - 1 ? { ...node, id: change.createdId!, name, markdown } : node));
      next = { ...created, nodes, mapPositions: {} };
      break;
    }
    case "update_node": {
      const node = findNode(forest, args.id);
      if (args.name === undefined && args.markdown === undefined && args.color === undefined) throw new Error("Nothing to update: give name, markdown or color");
      next = forest;
      if (typeof args.name === "string") next = renameAbilityNode(next, node.id, args.name.trim());
      if (typeof args.markdown === "string") next = updateAbilityMarkdown(next, node.id, args.markdown);
      if (typeof args.color === "string") {
        if (node.level !== 0) throw new Error("Only level-0 nodes have a color");
        if (!/^#[\da-fA-F]{6}$/.test(args.color)) throw new Error("color must be a hex value like #7FB77E");
        next = setAbilityNodeColor(next, node.id, args.color);
      }
      break;
    }
    case "move_node": {
      const node = findNode(forest, args.id);
      const parentId = typeof args.parentId === "string" && args.parentId ? args.parentId : null;
      next = { ...moveAbilityNode(forest, node.id, parentId, typeof args.position === "number" ? args.position : undefined), mapPositions: {} };
      break;
    }
    case "delete_node": {
      const node = findNode(forest, args.id);
      const deleted = deleteAbilityNode(forest, node.id);
      const ids = new Set(deleted.nodes.map((item) => item.id));
      const positions = deleted.mapPositions && Object.fromEntries(Object.entries(deleted.mapPositions).filter(([id]) => ids.has(id)));
      next = { ...deleted, mapPositions: positions };
      break;
    }
    default:
      throw new Error(`Unknown forest tool ${change.name}`);
  }
  return { ...forests, [map]: next };
}

export function describeForestChange(forests: Forests, change: ChangeInput): { kind: ChangeKind; title: string; detail: string } {
  const args = change.arguments;
  const map = mapOf(args);
  const forest = forests[map];
  const where = mapName(forest, map);
  const parentLabel = (parentId: unknown) => (typeof parentId === "string" && parentId ? findNode(forest, parentId).name : "顶层");
  switch (change.name) {
    case "add_node": {
      const parent = typeof args.parentId === "string" && args.parentId ? findNode(forest, args.parentId) : null;
      return { kind: "add", title: String(args.name).trim(), detail: `${where} · ${parent ? `${parent.name} 下的${LEVEL_LABELS[parent.level + 1] ?? "节点"}` : "新领域"}` };
    }
    case "update_node": {
      const node = findNode(forest, args.id);
      const parts = [
        typeof args.name === "string" && args.name.trim() !== node.name && `名称 → ${args.name.trim()}`,
        typeof args.markdown === "string" && "笔记已修改",
        typeof args.color === "string" && `颜色 → ${args.color}`,
      ].filter(Boolean);
      return { kind: "edit", title: node.name, detail: `${where} · ${parts.join(" · ") || "内容不变"}` };
    }
    case "move_node": {
      const node = findNode(forest, args.id);
      return { kind: "move", title: node.name, detail: `${where} · ${parentLabel(node.parentId)} → ${parentLabel(args.parentId)}` };
    }
    case "delete_node": {
      const node = findNode(forest, args.id);
      const descendants = subtreeSize(forest, node.id) - 1;
      return { kind: "del", title: node.name, detail: `${where}${descendants > 0 ? ` · 连同下面 ${descendants} 个节点` : ""}` };
    }
    default:
      throw new Error(`Unknown forest tool ${change.name}`);
  }
}
