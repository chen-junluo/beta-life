import type { AbilityForest, AbilityMapState, AbilityNode } from "./types";

export const ABILITY_FOREST_COLORS = ["#7FB77E", "#5A9FD4", "#E8856F"] as const;

export function orderedSiblings(forest: AbilityForest, parentId: string | null): AbilityNode[] {
  return forest.nodes
    .filter((node) => node.parentId === parentId)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

export function childrenOf(forest: AbilityForest, parentId: string): AbilityNode[] {
  return orderedSiblings(forest, parentId);
}

export function validateAbilityForest(forest: AbilityForest): AbilityForest {
  if (!forest || forest.schemaVersion !== 1 || !Array.isArray(forest.nodes)) {
    throw new Error("能力森林 JSON 必须包含 schemaVersion: 1 和 nodes 数组。");
  }
  if (forest.nodes.length > 5000) throw new Error("能力森林最多支持 5000 个节点。");
  if (forest.nodes.length === 0) throw new Error("能力森林至少需要一个顶层节点。");

  const byId = new Map<string, AbilityNode>();
  const siblingOrders = new Set<string>();
  for (const node of forest.nodes) {
    if (!node || !/^[A-Za-z0-9_-]{1,120}$/.test(node.id)) {
      throw new Error("每个节点都需要由字母、数字、连字符或下划线组成的 ID。");
    }
    if (byId.has(node.id)) throw new Error(`节点 ID 重复：${node.id}`);
    if (!node.name.trim()) throw new Error(`节点 ${node.id} 的名称不能为空。`);
    if (!Number.isInteger(node.level) || node.level < 0 || node.level > 2) {
      throw new Error(`节点「${node.name}」的层级必须是 0 到 2。`);
    }
    if (!Number.isSafeInteger(node.order) || node.order < 0) {
      throw new Error(`节点「${node.name}」的顺序无效。`);
    }
    if (typeof node.markdown !== "string") throw new Error(`节点「${node.name}」的 Markdown 内容无效。`);
    if (node.color !== null && node.level === 0 && !/^#[\da-fA-F]{6}$/.test(node.color)) {
      throw new Error(`节点「${node.name}」的颜色必须是六位十六进制颜色。`);
    }
    if (node.level > 0 && !node.parentId) throw new Error(`节点「${node.name}」需要一个父节点。`);
    const orderKey = `${node.parentId ?? "<root>"}:${node.order}`;
    if (siblingOrders.has(orderKey)) throw new Error("同一父节点下不能有重复的位置编号。");
    siblingOrders.add(orderKey);
    byId.set(node.id, node);
  }

  if (!forest.nodes.some((node) => node.parentId === null)) {
    throw new Error("能力森林至少需要一个顶层节点。");
  }
  for (const node of forest.nodes) {
    if (node.parentId === null) {
      if (node.level !== 0) throw new Error(`顶层节点「${node.name}」的层级必须为 0。`);
      continue;
    }
    const parent = byId.get(node.parentId);
    if (!parent) throw new Error(`找不到「${node.name}」的父节点 ${node.parentId}。`);
    if (node.level !== parent.level + 1) throw new Error(`「${node.name}」必须位于「${parent.name}」的下一层。`);
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(node: AbilityNode) {
    if (active.has(node.id)) throw new Error("能力树中存在循环关系。");
    if (visited.has(node.id)) return;
    active.add(node.id);
    visited.add(node.id);
    for (const child of childrenOf(forest, node.id)) visit(child);
    active.delete(node.id);
  }
  for (const root of orderedSiblings(forest, null)) visit(root);
  if (visited.size !== forest.nodes.length) throw new Error("有节点未连接到任何顶层节点，或层级关系存在循环。");
  if (forest.mapState) {
    const state = forest.mapState;
    if (!Number.isSafeInteger(state.seed) || state.seed < 0 || state.seed > 0xffffffff) throw new Error("地图种子无效。");
    if (!Number.isFinite(state.zoom) || state.zoom < 0.25 || state.zoom > 4) throw new Error("地图缩放比例无效。");
    if (!Number.isFinite(state.pan.x) || !Number.isFinite(state.pan.y)) throw new Error("地图平移位置无效。");
    if (!Number.isInteger(state.visibleLevels) || state.visibleLevels < 0 || state.visibleLevels > 3) throw new Error("地图名称显示范围无效。");
    const options = state.options;
    if (!options || !Number.isFinite(options.baseRadius) || !Number.isFinite(options.clusterSpread) || !Number.isFinite(options.largeNodeRadius) || !Number.isFinite(options.mediumNodeRadius)) {
      throw new Error("地图生成参数无效。");
    }
    if (state.selectedId !== null && !byId.has(state.selectedId)) state.selectedId = null;
  }
  return forest;
}

function reindexSiblings(nodes: AbilityNode[], parentId: string | null): void {
  nodes
    .filter((node) => node.parentId === parentId)
    .sort((left, right) => left.order - right.order)
    .forEach((node, index) => { node.order = index; });
}

function branchIds(forest: AbilityForest, rootId: string): Set<string> {
  const ids = new Set<string>();
  const visit = (id: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    childrenOf(forest, id).forEach((child) => visit(child.id));
  };
  visit(rootId);
  return ids;
}

function setBranchLevel(forest: AbilityForest, rootId: string, level: number): void {
  const node = forest.nodes.find((item) => item.id === rootId);
  if (!node) return;
  node.level = level;
  childrenOf(forest, rootId).forEach((child) => setBranchLevel(forest, child.id, level + 1));
}

export function createAbilityNode(forest: AbilityForest, parentId: string | null = null): AbilityForest {
  const parent = parentId ? forest.nodes.find((node) => node.id === parentId) : undefined;
  if (parentId && !parent) throw new Error("所选父节点已不存在。");
  const level = parent ? parent.level + 1 : 0;
  if (level > 2) throw new Error("小节点不能再添加子节点。");
  const siblings = orderedSiblings(forest, parentId);
  const name = level === 0 ? "新能力领域" : level === 1 ? "新能力组" : "新能力";
  const node: AbilityNode = {
    id: crypto.randomUUID(),
    name,
    level,
    parentId,
    order: siblings.reduce((maximum, sibling) => Math.max(maximum, sibling.order), -1) + 1,
    color: level === 0 ? ABILITY_FOREST_COLORS[0] : null,
    markdown: `# ${name}\n\n写下这个节点的说明。`,
  };
  return { ...forest, nodes: [...forest.nodes, node] };
}

export function renameAbilityNode(forest: AbilityForest, id: string, name: string): AbilityForest {
  return {
    ...forest,
    nodes: forest.nodes.map((node) => node.id === id ? { ...node, name } : node),
  };
}

export function updateAbilityMarkdown(forest: AbilityForest, id: string, markdown: string): AbilityForest {
  return {
    ...forest,
    nodes: forest.nodes.map((node) => node.id === id ? { ...node, markdown } : node),
  };
}

export function setAbilityNodeColor(forest: AbilityForest, id: string, color: string): AbilityForest {
  return {
    ...forest,
    nodes: forest.nodes.map((node) => node.id === id && node.level === 0 ? { ...node, color } : node),
  };
}

export function moveAbilityNode(
  source: AbilityForest,
  id: string,
  parentId: string | null,
  targetOrder?: number,
): AbilityForest {
  const forest = structuredClone(source);
  const node = forest.nodes.find((item) => item.id === id);
  if (!node) throw new Error("要移动的节点已不存在。");
  const parent = parentId ? forest.nodes.find((item) => item.id === parentId) : undefined;
  if (parentId && !parent) throw new Error("所选父节点已不存在。");
  if (parentId && branchIds(forest, id).has(parentId)) throw new Error("不能把节点移动到自己的子树中。");

  const nextLevel = parent ? parent.level + 1 : 0;
  const subtree = branchIds(forest, id);
  const height = Math.max(...[...subtree].map((branchId) => forest.nodes.find((item) => item.id === branchId)!.level - node.level));
  if (nextLevel + height > 2) throw new Error("移动后会超过原型支持的三层结构。");

  const previousParent = node.parentId;
  node.parentId = parentId;
  if (nextLevel === 0 && !node.color) node.color = ABILITY_FOREST_COLORS[0];
  setBranchLevel(forest, id, nextLevel);
  if (previousParent !== parentId) {
    reindexSiblings(forest.nodes, previousParent);
    const siblings = orderedSiblings(forest, parentId).filter((item) => item.id !== id);
    const index = Math.max(0, Math.min(targetOrder ?? siblings.length, siblings.length));
    siblings.splice(index, 0, node);
    siblings.forEach((item, order) => { item.order = order; });
  } else if (targetOrder !== undefined) {
    const siblings = orderedSiblings(forest, parentId);
    const index = siblings.findIndex((item) => item.id === id);
    const [moving] = siblings.splice(index, 1);
    siblings.splice(Math.max(0, Math.min(targetOrder, siblings.length)), 0, moving);
    siblings.forEach((item, order) => { item.order = order; });
  }
  return validateAbilityForest(forest);
}

export function reorderAbilityNode(forest: AbilityForest, id: string, direction: -1 | 1): AbilityForest {
  const node = forest.nodes.find((item) => item.id === id);
  if (!node) return forest;
  const siblings = orderedSiblings(forest, node.parentId);
  const index = siblings.findIndex((item) => item.id === id);
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= siblings.length) return forest;
  return moveAbilityNode(forest, id, node.parentId, nextIndex);
}

export function deleteAbilityNode(forest: AbilityForest, id: string): AbilityForest {
  const node = forest.nodes.find((item) => item.id === id);
  if (!node) return forest;
  if (node.parentId === null && orderedSiblings(forest, null).length === 1) {
    throw new Error("森林至少需要保留一个顶层节点。");
  }
  const removed = branchIds(forest, id);
  const next = { ...forest, nodes: forest.nodes.filter((item) => !removed.has(item.id)) };
  reindexSiblings(next.nodes, node.parentId);
  return validateAbilityForest(next);
}

export function parseAbilityForestJson(value: unknown): AbilityForest {
  if (!value || typeof value !== "object" || !Array.isArray((value as { nodes?: unknown }).nodes)) {
    throw new Error("JSON 文件需要包含 nodes 数组。");
  }
  const rawNodes = (value as { nodes: Array<Record<string, unknown>> }).nodes;
  const hasParentIds = rawNodes.every((node) => Object.hasOwn(node, "parentId"));
  let forest: AbilityForest;

  if (hasParentIds) {
    forest = {
      schemaVersion: 1,
      nodes: rawNodes.map((node) => ({
        id: String(node.id ?? ""),
        name: String(node.name ?? ""),
        level: Number(node.level),
        parentId: node.parentId === null || node.parentId === undefined ? null : String(node.parentId),
        order: Number(node.order ?? 0),
        color: typeof node.color === "string" ? node.color : null,
        markdown: typeof node.markdown === "string" ? node.markdown : typeof node.md === "string" ? node.md : "",
      })),
    };
  } else {
    const nodes: AbilityNode[] = [];
    const active = new Set<object>();
    const seen = new Set<string>();
    function walk(raw: Record<string, unknown>, parentId: string | null, level: number, order: number) {
      const id = String(raw.id ?? "");
      if (active.has(raw)) throw new Error("JSON 层级关系包含循环。");
      if (seen.has(id)) throw new Error(`JSON 中节点 ID 重复或被多个父节点引用：${id}`);
      if (Array.isArray(raw.children) && level > 2) throw new Error("能力森林最多支持三层节点。");
      active.add(raw);
      seen.add(id);
      nodes.push({
        id,
        name: String(raw.name ?? ""),
        level,
        parentId,
        order: Number(raw.order ?? order),
        color: typeof raw.color === "string" ? raw.color : null,
        markdown: typeof raw.markdown === "string" ? raw.markdown : typeof raw.md === "string" ? raw.md : "",
      });
      if (Array.isArray(raw.children)) {
        raw.children.forEach((child, index) => {
          if (!child || typeof child !== "object") throw new Error(`节点「${id}」的 children 包含无效节点。`);
          walk(child as Record<string, unknown>, id, level + 1, index);
        });
      }
      active.delete(raw);
    }
    rawNodes.forEach((node, index) => walk(node, null, 0, index));
    forest = { schemaVersion: 1, nodes };
  }

  forest.mapPositions = parseMapPositions((value as { mapPositions?: unknown }).mapPositions, forest.nodes);
  forest.mapState = parseMapState((value as { mapState?: unknown }).mapState, forest.nodes);

  return validateAbilityForest(forest);
}

function parseMapState(value: unknown, nodes: AbilityNode[]): AbilityMapState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const options = raw.options && typeof raw.options === "object" && !Array.isArray(raw.options) ? raw.options as Record<string, unknown> : undefined;
  const pan = raw.pan && typeof raw.pan === "object" && !Array.isArray(raw.pan) ? raw.pan as Record<string, unknown> : undefined;
  if (!options || !pan) return undefined;
  const selectedId = typeof raw.selectedId === "string" && nodes.some((node) => node.id === raw.selectedId) ? raw.selectedId : null;
  return {
    seed: Number(raw.seed ?? 42),
    zoom: Number(raw.zoom ?? 1),
    pan: { x: Number(pan.x ?? 0), y: Number(pan.y ?? 0) },
    visibleLevels: Number(raw.visibleLevels ?? 3),
    options: {
      baseRadius: Number(options.baseRadius ?? 22),
      clusterSpread: Number(options.clusterSpread ?? 8),
      largeNodeRadius: Number(options.largeNodeRadius ?? 8),
      mediumNodeRadius: Number(options.mediumNodeRadius ?? 15),
    },
    selectedId,
  };
}

function parseMapPositions(value: unknown, nodes: AbilityNode[]): AbilityForest["mapPositions"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const positions: NonNullable<AbilityForest["mapPositions"]> = {};
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const occupied = new Set<string>();
  for (const [id, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object") continue;
    const { x, y } = raw as { x?: unknown; y?: unknown };
    const node = byId.get(id);
    if (!node || !Number.isInteger(x) || !Number.isInteger(y)) continue;
    const position = { x: Number(x), y: Number(y) };
    const size = node.level === 0 ? 3 : node.level === 1 ? 2 : 1;
    if (position.x < 1 || position.y < 1 || position.x + size >= 79 || position.y + size >= 79) continue;
    let collides = false;
    for (let dx = -1; dx < size + 1 && !collides; dx++) {
      for (let dy = -1; dy < size + 1; dy++) {
        if (occupied.has(`${position.x + dx},${position.y + dy}`)) { collides = true; break; }
      }
    }
    if (collides) continue;
    for (let dx = -1; dx < size + 1; dx++) for (let dy = -1; dy < size + 1; dy++) occupied.add(`${position.x + dx},${position.y + dy}`);
    positions[id] = position;
  }
  return positions;
}
