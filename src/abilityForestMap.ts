import { childrenOf, orderedSiblings } from "./abilityForest";
import type { AbilityForest, AbilityNode } from "./types";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface AbilityMapOptions {
  baseRadius: number;
  clusterSpread: number;
  largeNodeRadius: number;
  mediumNodeRadius: number;
}

export interface AbilityMapPlant {
  id: string;
  x: number;
  y: number;
  size: 1 | 2 | 3;
}

export interface AbilityMapTile {
  x: number;
  y: number;
  rootId?: string;
}

export interface AbilityMapModel {
  gridSize: number;
  land: AbilityMapTile[];
  ocean: Array<{ x: number; y: number }>;
  plants: AbilityMapPlant[];
  seed: number;
  logs: string[];
}

export const DEFAULT_ABILITY_MAP_OPTIONS: AbilityMapOptions = {
  baseRadius: 22,
  clusterSpread: 8,
  largeNodeRadius: 8,
  mediumNodeRadius: 15,
};

const GRID_SIZE = 80;
const TILE_WIDTH = 20;
const TILE_HEIGHT = 12;
const STAGE_WIDTH = 1000;
const STAGE_HEIGHT = 700;
const MAP_OFFSET_Y = -46;
const BIOME_COLORS: Record<string, string> = {
  green: "#7FB77E",
  blue: "#5A9FD4",
  red: "#E8856F",
};
const TREE_MODELS = {
  green: { palette: ["#28542c", "#477c45", "#82b878", "#1f4926"], trunk: "#49382b", trunkLight: "#765b3d", trunkDark: "#2b211b" },
  blue: { palette: ["#142f49", "#2b5977", "#79b9cc", "#0c2033"], trunk: "#293b4d", trunkLight: "#48647b", trunkDark: "#172838" },
  red: { palette: ["#65252d", "#a63f43", "#ed8565", "#4d1d26"], trunk: "#55342e", trunkLight: "#80503d", trunkDark: "#321d1c" },
};
type Biome = keyof typeof TREE_MODELS;
type Point = { x: number; y: number };

function createRandom(initialSeed: number) {
  let state = initialSeed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function mapNoise(x: number, y: number, seed: number): number {
  const broad = Math.sin((x + seed * 0.37) * 0.34) * 2.1 + Math.cos((y - seed * 0.23) * 0.31) * 2.2;
  const detail = Math.sin((x + y + seed * 0.11) * 0.63) * 1.3 + Math.cos((x - y - seed * 0.17) * 0.57) * 1.1;
  const hash = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return broad + detail + (hash - Math.floor(hash) - 0.5) * 1.3;
}

function rootFor(forest: AbilityForest, node: AbilityNode): AbilityNode {
  let current = node;
  const visited = new Set<string>();
  while (current.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    current = forest.nodes.find((item) => item.id === current.parentId) ?? current;
    if (current.id === node.id) break;
  }
  return current;
}

function biomeForRoot(root: AbilityNode, index: number): Biome {
  const color = root.color?.toUpperCase();
  const match = Object.entries(BIOME_COLORS).find(([, value]) => value.toUpperCase() === color)?.[0];
  if (match === "blue" || match === "red") return match;
  if (match === "green") return "green";
  return (["green", "blue", "red"] as const)[index % 3];
}

function centersFor(roots: AbilityNode[], spread: number): Array<Point & { root: AbilityNode }> {
  const center = GRID_SIZE / 2;
  if (roots.length === 3) {
    return [
      { root: roots[0], x: center - spread, y: center - spread },
      { root: roots[1], x: center + spread * 0.3, y: center - spread * 0.3 },
      { root: roots[2], x: center + spread, y: center + spread },
    ];
  }
  if (roots.length === 1) return [{ root: roots[0], x: center, y: center }];
  const radius = roots.length === 2 ? spread * 0.88 : Math.min(22, spread + Math.sqrt(roots.length) * 2.1);
  return roots.map((root, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / roots.length;
    return { root, x: center + Math.cos(angle) * radius, y: center + Math.sin(angle) * radius };
  });
}

function buildOnce(forest: AbilityForest, worldSeed: number, options: AbilityMapOptions, radius: number): Omit<AbilityMapModel, "seed" | "logs"> | null {
  const random = createRandom(worldSeed);
  const roots = orderedSiblings(forest, null);
  const centers = centersFor(roots, options.clusterSpread);
  const center = GRID_SIZE / 2;
  const landSet = new Set<string>();
  for (let x = 0; x < GRID_SIZE; x++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      if (Math.hypot(x + 0.5 - center, y + 0.5 - center) < radius + mapNoise(x, y, worldSeed)) landSet.add(`${x},${y}`);
    }
  }

  const occupied = new Set<string>();
  const plants: AbilityMapPlant[] = [];
  const canPlace = (x: number, y: number, size: number) => {
    if (x < 1 || y < 1 || x + size >= GRID_SIZE - 1 || y + size >= GRID_SIZE - 1) return false;
    for (let dx = -1; dx < size + 1; dx++) {
      for (let dy = -1; dy < size + 1; dy++) {
        const key = `${x + dx},${y + dy}`;
        if (dx >= 0 && dx < size && dy >= 0 && dy < size && !landSet.has(key)) return false;
        if (occupied.has(key)) return false;
      }
    }
    return true;
  };
  const reserve = (x: number, y: number, size: number) => {
    for (let dx = -1; dx < size + 1; dx++) for (let dy = -1; dy < size + 1; dy++) occupied.add(`${x + dx},${y + dy}`);
  };
  const place = (cx: number, cy: number, maxRadius: number, size: 1 | 2 | 3): Point | null => {
    for (let attempt = 0; attempt < 1600; attempt++) {
      const angle = random() * Math.PI * 2;
      const distance = Math.sqrt(random()) * maxRadius;
      const x = Math.floor(cx + Math.cos(angle) * distance);
      const y = Math.floor(cy + Math.sin(angle) * distance);
      if (canPlace(x, y, size)) {
        reserve(x, y, size);
        return { x, y };
      }
    }
    return null;
  };

  for (const { root, x, y } of centers) {
    const rootPosition = place(x, y, options.largeNodeRadius, 3);
    if (!rootPosition) return null;
    plants.push({ id: root.id, ...rootPosition, size: 3 });
    const middleNodes = childrenOf(forest, root.id);
    for (const middle of middleNodes) {
      const middlePosition = place(rootPosition.x + 1.5, rootPosition.y + 1.5, options.mediumNodeRadius, 2);
      if (!middlePosition) return null;
      plants.push({ id: middle.id, ...middlePosition, size: 2 });
      for (const leaf of childrenOf(forest, middle.id)) {
        const leafPosition = place(middlePosition.x + 1, middlePosition.y + 1, 5, 1);
        if (!leafPosition) return null;
        plants.push({ id: leaf.id, ...leafPosition, size: 1 });
      }
    }
  }
  if (plants.length !== forest.nodes.length) return null;

  const oceanKeys = new Set<string>();
  landSet.forEach((key) => {
    const [x, y] = key.split(",").map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE && !landSet.has(`${nx},${ny}`)) oceanKeys.add(`${nx},${ny}`);
    }
  });

  const plantRoots = plants.map((plant) => {
    const node = forest.nodes.find((item) => item.id === plant.id)!;
    return { plant, root: rootFor(forest, node) };
  });
  const land: AbilityMapTile[] = Array.from(landSet, (key) => {
    const [x, y] = key.split(",").map(Number);
    let nearest = plantRoots[0];
    let bestScore = Infinity;
    plantRoots.forEach(({ plant, root }, index) => {
      const distance = Math.hypot(x - (plant.x + plant.size / 2), y - (plant.y + plant.size / 2));
      const score = distance + mapNoise(x + index * 29, y - index * 23, worldSeed) * 0.12;
      if (score < bestScore) { nearest = { plant, root }; bestScore = score; }
    });
    return { x, y, rootId: nearest?.root.id };
  });
  const ocean = Array.from(oceanKeys, (key) => {
    const [x, y] = key.split(",").map(Number);
    return { x, y };
  });
  return { gridSize: GRID_SIZE, land, ocean, plants };
}

export function generateAbilityMap(
  forest: AbilityForest,
  seed: number,
  options: AbilityMapOptions = DEFAULT_ABILITY_MAP_OPTIONS,
): AbilityMapModel {
  const logs = [`种子: ${seed}，大陆半径: ${options.baseRadius}，群落分散度: ${options.clusterSpread}`, `搜索半径: 大节点 ${options.largeNodeRadius}，中节点 ${options.mediumNodeRadius}`];
  if (forest.nodes.length === 0) return { gridSize: GRID_SIZE, land: [], ocean: [], plants: [], seed, logs: [...logs, "森林中没有可显示的节点。"] };
  let result: Omit<AbilityMapModel, "seed" | "logs"> | null = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const attemptRadius = Math.min(38, options.baseRadius + attempt * 1.5);
    result = buildOnce(forest, seed + attempt, options, attemptRadius);
    if (result) {
      if (attempt > 0) logs.push(`第 ${attempt + 1} 次尝试后放置全部节点。`);
      break;
    }
  }
  if (!result) {
    // A dense or unusually large tree still gets a complete, deterministic map.
    const roots = orderedSiblings(forest, null);
    const fallbackPlants: AbilityMapPlant[] = [];
    const occupied = new Set<string>();
    const ordered: AbilityNode[] = [];
    const visit = (node: AbilityNode) => { ordered.push(node); childrenOf(forest, node.id).forEach(visit); };
    roots.forEach(visit);
    for (const node of ordered) {
      const size = (node.level === 0 ? 3 : node.level === 1 ? 2 : 1) as 1 | 2 | 3;
      const parent = node.parentId ? fallbackPlants.find((plant) => plant.id === node.parentId) : undefined;
      let position: Point | undefined;
      const anchorX = parent ? parent.x + parent.size / 2 : GRID_SIZE / 2;
      const anchorY = parent ? parent.y + parent.size / 2 : GRID_SIZE / 2;
      for (let step = 0; step < GRID_SIZE * GRID_SIZE; step++) {
        const angle = step * 2.399963229728653;
        const distance = 3 + Math.sqrt(step) * 1.2;
        const x = Math.max(1, Math.min(GRID_SIZE - size - 2, Math.floor(anchorX + Math.cos(angle) * distance)));
        const y = Math.max(1, Math.min(GRID_SIZE - size - 2, Math.floor(anchorY + Math.sin(angle) * distance)));
        let free = true;
        for (let dx = -1; dx < size + 1 && free; dx++) for (let dy = -1; dy < size + 1; dy++) if (occupied.has(`${x + dx},${y + dy}`)) { free = false; break; }
        if (free) { position = { x, y }; break; }
      }
      position ??= { x: 1 + fallbackPlants.length % 70, y: 1 + Math.floor(fallbackPlants.length / 70) % 70 };
      for (let dx = -1; dx < size + 1; dx++) for (let dy = -1; dy < size + 1; dy++) occupied.add(`${position.x + dx},${position.y + dy}`);
      fallbackPlants.push({ id: node.id, ...position, size });
    }
    const landSet = new Set<string>();
    for (let x = 0; x < GRID_SIZE; x++) for (let y = 0; y < GRID_SIZE; y++) {
      if (Math.hypot(x + 0.5 - GRID_SIZE / 2, y + 0.5 - GRID_SIZE / 2) < 38 + mapNoise(x, y, seed)) landSet.add(`${x},${y}`);
    }
    const rootForId = new Map(forest.nodes.map((node) => [node.id, rootFor(forest, node).id]));
    result = {
      gridSize: GRID_SIZE,
      plants: fallbackPlants,
      land: Array.from(landSet, (key) => { const [x, y] = key.split(",").map(Number); const nearest = fallbackPlants.slice().sort((a, b) => Math.hypot(x - a.x, y - a.y) - Math.hypot(x - b.x, y - b.y))[0]; return { x, y, rootId: nearest ? rootForId.get(nearest.id) : undefined }; }),
      ocean: [],
    };
    logs.push("节点较密，已使用紧凑布局。拖动树木可重新安排地图位置。");
  }
  logs.push(`生成完成：${result.land.length} 格地形，${result.plants.length} 棵树。`);
  return { ...result, seed, logs };
}

function gridToScreen(x: number, y: number): Point {
  return { x: (x - y) * TILE_WIDTH / 2 + STAGE_WIDTH / 2, y: (x + y) * TILE_HEIGHT / 2 + MAP_OFFSET_Y };
}

function hexMix(hex: string, target: string, amount: number): string {
  const source = hex.match(/[\da-f]{2}/gi)?.map((value) => parseInt(value, 16)) ?? [127, 183, 126];
  const destination = target.match(/[\da-f]{2}/gi)?.map((value) => parseInt(value, 16)) ?? [255, 255, 255];
  return `#${source.map((value, index) => Math.round(value + (destination[index] - value) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function colorSetFor(forest: AbilityForest, node: AbilityNode) {
  const root = rootFor(forest, node);
  const color = root.color ?? BIOME_COLORS.green;
  const rootIndex = orderedSiblings(forest, null).findIndex((item) => item.id === root.id);
  const theme = biomeForRoot(root, rootIndex);
  const model = TREE_MODELS[theme];
  return { theme, land: BIOME_COLORS[theme], palette: model.palette, label: hexMix(color, "#ffffff", 0.78), border: hexMix(color, "#28352b", 0.38) };
}

function isoTile(ctx: CanvasRenderingContext2D, tile: { x: number; y: number }, fill: string) {
  const point = gridToScreen(tile.x, tile.y);
  ctx.beginPath();
  ctx.moveTo(point.x, point.y);
  ctx.lineTo(point.x + TILE_WIDTH / 2, point.y + TILE_HEIGHT / 2);
  ctx.lineTo(point.x, point.y + TILE_HEIGHT);
  ctx.lineTo(point.x - TILE_WIDTH / 2, point.y + TILE_HEIGHT / 2);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.1)";
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

function treeOrb(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, palette: string[], alpha = 0.9) {
  const inheritedAlpha = ctx.globalAlpha;
  ctx.save();
  ctx.globalAlpha = inheritedAlpha * alpha * 0.62; ctx.fillStyle = palette[0]; ctx.beginPath(); ctx.ellipse(x + 2.5, y + 4, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = inheritedAlpha * alpha; ctx.fillStyle = palette[1]; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = inheritedAlpha * 0.34; ctx.fillStyle = palette[2]; ctx.beginPath(); ctx.ellipse(x - rx * 0.28, y - ry * 0.31, rx * 0.42, ry * 0.39, -0.35, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = inheritedAlpha * 0.28; ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.ellipse(x - rx * 0.39, y - ry * 0.48, Math.max(2, rx * 0.18), Math.max(2, ry * 0.16), -0.3, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = inheritedAlpha * alpha * 0.32; ctx.strokeStyle = palette[3]; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function treeBranch(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width = 2) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
}

function drawRoundCrown(ctx: CanvasRenderingContext2D, x: number, top: number, size: number, palette: string[]) {
  if (size === 1) {
    treeBranch(ctx, x, top + 2, x - 7, top - 7, palette[0], 1.5); treeBranch(ctx, x, top + 3, x + 7, top - 6, palette[0], 1.5);
    treeOrb(ctx, x, top - 8, 8, 8, palette); treeOrb(ctx, x - 7, top - 5, 5.5, 5.5, palette, 0.82); treeOrb(ctx, x + 7, top - 4, 5.5, 5.5, palette, 0.82);
  } else if (size === 2) {
    treeBranch(ctx, x, top + 4, x - 13, top - 9, palette[0], 2); treeBranch(ctx, x, top + 2, x + 13, top - 11, palette[0], 2);
    treeOrb(ctx, x, top - 15, 14, 14, palette); treeOrb(ctx, x - 12, top - 7, 11, 11, palette, 0.86); treeOrb(ctx, x + 13, top - 8, 11, 11, palette, 0.88); treeOrb(ctx, x + 1, top - 2, 9, 9, palette, 0.84);
  } else {
    treeBranch(ctx, x, top + 7, x - 22, top - 13, palette[0], 3); treeBranch(ctx, x, top + 4, x + 23, top - 16, palette[0], 3);
    treeOrb(ctx, x, top - 23, 23, 23, palette); treeOrb(ctx, x - 21, top - 12, 17, 17, palette, 0.87); treeOrb(ctx, x + 22, top - 14, 18, 18, palette, 0.87); treeOrb(ctx, x - 12, top + 1, 14, 14, palette, 0.82); treeOrb(ctx, x + 13, top, 14, 14, palette, 0.84);
  }
}

function drawMapleCrown(ctx: CanvasRenderingContext2D, x: number, top: number, size: number, palette: string[]) {
  const layouts: Record<number, number[][]> = {
    1: [[0, -13, 10, 0], [-8, -9, 9, -0.4], [8, -9, 9, 0.4], [-4, -21, 8, -0.2], [5, -20, 8, 0.2]],
    2: [[0, -22, 15, 0], [-13, -16, 13, -0.4], [13, -16, 13, 0.4], [-8, -31, 12, -0.2], [8, -30, 12, 0.2], [-21, -8, 11, -0.6], [21, -8, 11, 0.6], [-5, -7, 11, -0.1], [6, -7, 11, 0.1]],
    3: [[0, -33, 20, 0], [-17, -28, 17, -0.4], [17, -28, 17, 0.4], [-32, -18, 16, -0.65], [32, -18, 16, 0.65], [-12, -15, 17, -0.3], [13, -15, 17, 0.3], [-28, -4, 15, -0.75], [28, -4, 15, 0.75], [-10, 0, 15, -0.2], [10, 0, 15, 0.2], [0, -10, 18, 0]],
  };
  const leaf = (px: number, py: number, scale: number, rotation: number) => {
    const inheritedAlpha = ctx.globalAlpha;
    ctx.save(); ctx.translate(px, py); ctx.rotate(rotation); ctx.scale(scale, scale); ctx.fillStyle = palette[1]; ctx.strokeStyle = palette[3]; ctx.lineWidth = 0.055; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(0, -0.98); ctx.quadraticCurveTo(-0.08, -0.68, -0.28, -0.57); ctx.quadraticCurveTo(-0.24, -0.86, -0.55, -0.78); ctx.quadraticCurveTo(-0.57, -0.52, -0.91, -0.43); ctx.quadraticCurveTo(-0.67, -0.25, -0.76, 0.02); ctx.quadraticCurveTo(-0.49, -0.04, -0.39, 0.22); ctx.quadraticCurveTo(-0.6, 0.55, -0.34, 0.86); ctx.quadraticCurveTo(-0.12, 0.57, 0, 0.43); ctx.quadraticCurveTo(0.12, 0.57, 0.34, 0.86); ctx.quadraticCurveTo(0.6, 0.55, 0.39, 0.22); ctx.quadraticCurveTo(0.49, -0.04, 0.76, 0.02); ctx.quadraticCurveTo(0.67, -0.25, 0.91, -0.43); ctx.quadraticCurveTo(0.57, -0.52, 0.55, -0.78); ctx.quadraticCurveTo(0.24, -0.86, 0.28, -0.57); ctx.quadraticCurveTo(0.08, -0.68, 0, -0.98); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.globalAlpha = inheritedAlpha * 0.5; ctx.strokeStyle = palette[2]; ctx.lineWidth = 0.035; ctx.beginPath(); ctx.moveTo(0, 0.42); ctx.lineTo(0, -0.83); ctx.moveTo(0, -0.2); ctx.lineTo(-0.57, -0.55); ctx.moveTo(0, -0.16); ctx.lineTo(0.57, -0.55); ctx.stroke(); ctx.restore();
  };
  layouts[size].forEach(([dx, dy, radius, angle]) => { treeBranch(ctx, x, top + 4, x + dx, top + dy + radius * 0.28, palette[0], size === 3 ? 2.5 : 1.7); leaf(x + dx, top + dy, radius, angle); });
}

function drawNightCrown(ctx: CanvasRenderingContext2D, x: number, top: number, size: number, palette: string[]) {
  const nodes = size === 1 ? [[0, -14, 8, 8], [-7, -7, 7, 7], [7, -7, 7, 7]] : size === 2 ? [[0, -27, 14, 13], [-14, -17, 12, 11], [14, -17, 12, 11], [-23, -7, 10, 9], [22, -6, 11, 9], [0, -8, 14, 10]] : [[-4, -37, 20, 17], [-22, -27, 17, 15], [17, -28, 18, 15], [-34, -15, 13, 12], [32, -15, 14, 12], [-18, -8, 16, 11], [17, -7, 17, 11], [0, -17, 19, 15]];
  nodes.forEach(([dx, dy, rx, ry]) => treeBranch(ctx, x, top + 4, x + dx, top + dy + ry * 0.32, palette[0], size === 3 ? 3.2 : 2));
  nodes.forEach(([dx, dy, rx, ry]) => treeOrb(ctx, x + dx, top + dy, rx, ry, palette));
}

function drawPickedTree(ctx: CanvasRenderingContext2D, forest: AbilityForest, plant: AbilityMapPlant, node: AbilityNode) {
  const point = gridToScreen(plant.x + plant.size / 2, plant.y + plant.size / 2);
  const colors = colorSetFor(forest, node);
  const model = TREE_MODELS[colors.theme];
  const scale = TILE_WIDTH / 24;
  const trunkWidth = (plant.size === 3 ? 6.4 : plant.size === 2 ? 4.7 : 3.2) * scale;
  const trunkHeight = (plant.size === 3 ? 43 : plant.size === 2 ? 31 : 19) * scale;
  const top = point.y - trunkHeight;
  ctx.save();
  ctx.fillStyle = model.trunkDark; ctx.beginPath(); ctx.moveTo(point.x - trunkWidth, point.y - 2); ctx.lineTo(point.x, point.y + 3); ctx.lineTo(point.x, top + 2); ctx.lineTo(point.x - trunkWidth * 0.72, top); ctx.closePath(); ctx.fill();
  ctx.fillStyle = model.trunk; ctx.beginPath(); ctx.moveTo(point.x, point.y + 3); ctx.lineTo(point.x + trunkWidth, point.y - 2); ctx.lineTo(point.x + trunkWidth * 0.72, top); ctx.lineTo(point.x, top + 2); ctx.closePath(); ctx.fill();
  ctx.fillStyle = model.trunkLight; ctx.beginPath(); ctx.moveTo(point.x - trunkWidth * 0.72, top); ctx.lineTo(point.x, top - 2); ctx.lineTo(point.x + trunkWidth * 0.72, top); ctx.lineTo(point.x, top + 2); ctx.closePath(); ctx.fill();
  if (colors.theme === "blue" && plant.size === 3) {
    ctx.fillStyle = model.trunkDark; ctx.beginPath(); ctx.moveTo(point.x - trunkWidth, point.y - 3); ctx.lineTo(point.x - trunkWidth - 9 * scale, point.y + 1); ctx.lineTo(point.x - trunkWidth + scale, point.y - 8 * scale); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(point.x + trunkWidth, point.y - 3); ctx.lineTo(point.x + trunkWidth + 9 * scale, point.y + 1); ctx.lineTo(point.x + trunkWidth - scale, point.y - 8 * scale); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  ctx.save(); ctx.translate(point.x, top); ctx.scale(scale, scale);
  if (colors.theme === "red") drawMapleCrown(ctx, 0, 0, plant.size, colors.palette);
  else if (colors.theme === "blue") drawNightCrown(ctx, 0, 0, plant.size, colors.palette);
  else drawRoundCrown(ctx, 0, 0, plant.size, colors.palette);
  ctx.restore();
}

function nodeMapPoint(plant: AbilityMapPlant): Point {
  return gridToScreen(plant.x + plant.size / 2, plant.y + plant.size / 2);
}

function relatedToSelection(forest: AbilityForest, id: string, selectedId: string | null): boolean {
  if (selectedId === null) return true;
  let current = forest.nodes.find((node) => node.id === id);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.id === selectedId) return true;
    visited.add(current.id);
    current = current.parentId ? forest.nodes.find((node) => node.id === current?.parentId) : undefined;
  }
  current = forest.nodes.find((node) => node.id === selectedId);
  visited.clear();
  while (current && !visited.has(current.id)) {
    if (current.id === id) return true;
    visited.add(current.id);
    current = current.parentId ? forest.nodes.find((node) => node.id === current?.parentId) : undefined;
  }
  return false;
}

function roundedPath(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + width - r, y); ctx.arcTo(x + width, y, x + width, y + r, r); ctx.lineTo(x + width, y + height - r); ctx.arcTo(x + width, y + height, x + width - r, y + height, r); ctx.lineTo(x + r, y + height); ctx.arcTo(x, y + height, x, y + height - r, r); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}

export interface AbilityMapHitArea {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AbilityMapMetrics {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  hitAreas: AbilityMapHitArea[];
}

export interface AbilityMapCollision {
  x: number;
  y: number;
  size: number;
}

function nodeLabelInfo(node: AbilityNode, point: Point) {
  const shown = node.name.trim() || "未命名节点";
  const textWidth = Array.from(shown).reduce((width, character) => {
    // CJK glyphs occupy roughly the full 10px label font; Latin text is narrower.
    return width + (/[^\u0000-\u00ff]/u.test(character) ? 10 : 6.2);
  }, 0);
  const width = Math.max(58, textWidth + 24);
  const top = point.y - (node.level === 0 ? 91 : node.level === 1 ? 65 : 43);
  return { shown, width, x: point.x - width / 2, y: top, height: 22 };
}

function drawNodeLabel(ctx: CanvasRenderingContext2D, forest: AbilityForest, node: AbilityNode, point: Point, active: boolean) {
  const info = nodeLabelInfo(node, point);
  const colors = colorSetFor(forest, node);
  ctx.save();
  if (active) { ctx.shadowColor = colors.border; ctx.shadowBlur = 12; }
  roundedPath(ctx, info.x, info.y, info.width, info.height, 3);
  ctx.fillStyle = colors.label; ctx.fill(); ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
  ctx.strokeStyle = colors.border; ctx.lineWidth = active ? 2.4 : 1; ctx.stroke();
  ctx.fillStyle = colors.border; ctx.fillRect(info.x, info.y, 3, info.height);
  ctx.fillStyle = "#2a2e28"; ctx.font = "600 10px 'PingFang SC','Microsoft YaHei',sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(info.shown, point.x, info.y + info.height / 2, info.width - 12);
  ctx.restore();
  return info;
}

export function drawAbilityMap(
  canvas: HTMLCanvasElement,
  forest: AbilityForest,
  model: AbilityMapModel,
  plants: AbilityMapPlant[],
  selectedId: string | null,
  visibleLevels: number,
  zoom: number,
  pan: Point = { x: 0, y: 0 },
  collision: AbilityMapCollision | null = null,
): AbilityMapMetrics | null {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (width <= 0 || height <= 0) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
  const backingWidth = Math.max(1, Math.round(width * pixelRatio));
  const backingHeight = Math.max(1, Math.round(height * pixelRatio));
  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;
  const scale = Math.min(width / STAGE_WIDTH, height / STAGE_HEIGHT) * zoom;
  const offsetX = (width - STAGE_WIDTH * scale) / 2 + pan.x;
  const offsetY = (height - STAGE_HEIGHT * scale) / 2 + pan.y;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.save(); ctx.translate(offsetX, offsetY); ctx.scale(scale, scale);
  model.ocean.forEach((tile) => isoTile(ctx, tile, "rgba(74,144,196,.6)"));
  const rootNodes = orderedSiblings(forest, null);
  const rootIndex = new Map(rootNodes.map((root, index) => [root.id, index]));
  const nodeById = new Map(forest.nodes.map((node) => [node.id, node]));
  model.land.forEach((tile) => {
    const root = tile.rootId ? nodeById.get(tile.rootId) : undefined;
    const colorSet = root ? colorSetFor(forest, root) : null;
    isoTile(ctx, tile, colorSet?.land ?? BIOME_COLORS.green);
  });
  if (collision) {
    ctx.save();
    for (let dx = 0; dx < collision.size; dx++) for (let dy = 0; dy < collision.size; dy++) {
      const tile = { x: collision.x + dx, y: collision.y + dy };
      const point = gridToScreen(tile.x, tile.y);
      ctx.beginPath(); ctx.moveTo(point.x, point.y); ctx.lineTo(point.x + TILE_WIDTH / 2, point.y + TILE_HEIGHT / 2); ctx.lineTo(point.x, point.y + TILE_HEIGHT); ctx.lineTo(point.x - TILE_WIDTH / 2, point.y + TILE_HEIGHT / 2); ctx.closePath();
      ctx.fillStyle = "rgba(255, 35, 35, .48)"; ctx.fill(); ctx.strokeStyle = "#e3231c"; ctx.lineWidth = 2.4; ctx.stroke();
    }
    ctx.restore();
  }
  const byId = new Map(plants.map((plant) => [plant.id, plant]));
  forest.nodes.forEach((node) => {
    const parentPlant = byId.get(node.id);
    if (!parentPlant) return;
    childrenOf(forest, node.id).forEach((child) => {
      const childPlant = byId.get(child.id);
      if (!childPlant) return;
      const from = nodeMapPoint(parentPlant);
      const to = nodeMapPoint(childPlant);
      const selectedNode = selectedId ? nodeById.get(selectedId) : undefined;
      const related = selectedId !== null && relatedToSelection(forest, node.id, selectedId) && relatedToSelection(forest, child.id, selectedId)
        && !(selectedNode?.level === 0 && (node.level === 2 || child.level === 2));
      const colors = colorSetFor(forest, child);
      ctx.save();
      ctx.strokeStyle = related ? colors.palette[2] : selectedId === null ? colors.palette[0] : "#6f786f";
      ctx.lineWidth = related ? 3.2 : 1.5;
      ctx.globalAlpha = related ? 0.96 : selectedId === null ? 0.3 : 0.1;
      ctx.setLineDash([4, 4]); ctx.shadowColor = related ? colors.border : "transparent"; ctx.shadowBlur = related ? 7 : 0;
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      ctx.setLineDash([]); ctx.shadowBlur = 0;
      ctx.globalAlpha = related ? 0.82 : selectedId === null ? 0.17 : 0.08;
      ctx.fillStyle = colors.palette[1]; ctx.beginPath(); ctx.arc(to.x, to.y, related ? 6 : 4, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    });
  });
  const hitAreas: AbilityMapHitArea[] = [];
  plants.slice().sort((a, b) => (a.x + a.y + a.size) - (b.x + b.y + b.size)).forEach((plant) => {
    const node = nodeById.get(plant.id);
    if (!node) return;
    const point = nodeMapPoint(plant);
    const selectedNode = selectedId ? nodeById.get(selectedId) : undefined;
    const related = relatedToSelection(forest, node.id, selectedId) && !(selectedNode?.level === 0 && node.level === 2);
    if (selectedId !== null && !related) return;
    const active = selectedId !== null && node.id === selectedId;
    const labelInfo = nodeLabelInfo(node, point);
    ctx.save(); ctx.globalAlpha = related ? 1 : 0.22;
    if (related && selectedId !== null) {
      const colors = colorSetFor(forest, node);
      ctx.strokeStyle = colors.border; ctx.lineWidth = active ? 2.5 : 1.5; ctx.globalAlpha = active ? 0.72 : 0.32;
      ctx.beginPath(); ctx.ellipse(point.x, point.y + 2, plant.size * 11 + (active ? 14 : 8), plant.size * 6 + (active ? 9 : 5), 0, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.shadowColor = related && selectedId !== null ? colorSetFor(forest, node).border : "transparent";
    ctx.shadowBlur = active ? 18 : related && selectedId !== null ? 9 : 0;
    drawPickedTree(ctx, forest, plant, node); ctx.shadowBlur = 0;
    if (node.level < visibleLevels) drawNodeLabel(ctx, forest, node, point, active);
    ctx.restore();
    const crownHeight = plant.size === 3 ? 98 : plant.size === 2 ? 66 : 39;
    const crownWidth = plant.size === 3 ? 82 : plant.size === 2 ? 58 : 36;
    const labelTop = node.level < visibleLevels ? labelInfo.y : Infinity;
    const top = Math.min(labelTop, point.y - crownHeight);
    hitAreas.push({ id: node.id, x: Math.min(node.level < visibleLevels ? labelInfo.x : Infinity, point.x - crownWidth / 2), y: top, width: Math.max(node.level < visibleLevels ? labelInfo.width : 0, crownWidth), height: point.y + 14 - top });
  });
  ctx.restore();
  return { width, height, scale, offsetX, offsetY, hitAreas };
}

export function eventToAbilityMapPoint(event: PointerEvent | ReactPointerEvent<HTMLCanvasElement>, metrics: AbilityMapMetrics): Point {
  const target = event.currentTarget as HTMLCanvasElement;
  const rect = target.getBoundingClientRect();
  return { x: (event.clientX - rect.left - metrics.offsetX) / metrics.scale, y: (event.clientY - rect.top - metrics.offsetY) / metrics.scale };
}

export function abilityMapScreenToGrid(x: number, y: number): Point {
  const centeredX = (x - STAGE_WIDTH / 2) / (TILE_WIDTH / 2);
  const centeredY = (y - MAP_OFFSET_Y) / (TILE_HEIGHT / 2);
  return { x: Math.floor((centeredX + centeredY) / 2), y: Math.floor((centeredY - centeredX) / 2) };
}

export function abilityMapHitTest(point: Point, metrics: AbilityMapMetrics, plants: AbilityMapPlant[]): string | null {
  const grid = abilityMapScreenToGrid(point.x, point.y);
  const basePlant = plants.slice().sort((a, b) => (b.x + b.y + b.size) - (a.x + a.y + a.size)).find((plant) => grid.x >= plant.x && grid.x < plant.x + plant.size && grid.y >= plant.y && grid.y < plant.y + plant.size);
  if (basePlant) return basePlant.id;
  for (let index = metrics.hitAreas.length - 1; index >= 0; index--) {
    const area = metrics.hitAreas[index];
    if (point.x >= area.x && point.x <= area.x + area.width && point.y >= area.y && point.y <= area.y + area.height) return area.id;
  }
  return null;
}

export function abilityMapCanMove(plant: AbilityMapPlant, x: number, y: number, plants: AbilityMapPlant[], gridSize: number): boolean {
  if (x < 1 || y < 1 || x + plant.size >= gridSize - 1 || y + plant.size >= gridSize - 1) return false;
  return !plants.some((other) => other.id !== plant.id && x - 1 < other.x + other.size + 1 && x + plant.size + 1 > other.x - 1 && y - 1 < other.y + other.size + 1 && y + plant.size + 1 > other.y - 1);
}

export function nearestPlantAtGrid(x: number, y: number, plants: AbilityMapPlant[]): AbilityMapPlant | undefined {
  return plants.slice().sort((left, right) => Math.hypot(x - (left.x + left.size / 2), y - (left.y + left.size / 2)) - Math.hypot(x - (right.x + right.size / 2), y - (right.y + right.size / 2)))[0];
}

export const ABILITY_MAP_VIEWPORT = { width: STAGE_WIDTH, height: STAGE_HEIGHT, offsetY: MAP_OFFSET_Y };
