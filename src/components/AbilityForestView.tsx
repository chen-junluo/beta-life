import {
  ArrowDown,
  ArrowUp,
  Download,
  FileJson,
  Minus,
  Plus,
  RotateCw,
  Save,
  ScrollText,
  Settings2,
  Trash2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  ABILITY_FOREST_COLORS,
  childrenOf,
  createAbilityNode,
  deleteAbilityNode,
  moveAbilityNode,
  orderedSiblings,
  parseAbilityForestJson,
  reorderAbilityNode,
  renameAbilityNode,
  setAbilityNodeColor,
  updateAbilityMarkdown,
} from "../abilityForest";
import {
  abilityMapCanMove,
  abilityMapHitTest,
  abilityMapScreenToGrid,
  DEFAULT_ABILITY_MAP_OPTIONS,
  drawAbilityMap,
  eventToAbilityMapPoint,
  generateAbilityMap,
  nearestPlantAtGrid,
  type AbilityMapMetrics,
  type AbilityMapOptions,
  type AbilityMapPlant,
} from "../abilityForestMap";
import type { AbilityForest, AbilityMapState, AbilityNode } from "../types";

type ForestSaveState = "saved" | "saving" | "error";

interface AbilityForestViewProps {
  forest: AbilityForest;
  saveState: ForestSaveState;
  onForestChange: (forest: AbilityForest, immediate?: boolean) => void;
}

const levelNames = ["大节点", "中节点", "小节点"];
const fallbackColor = ABILITY_FOREST_COLORS[0];
const DEFAULT_MAP_STATE: AbilityMapState = {
  seed: 42,
  zoom: 1,
  pan: { x: 0, y: 0 },
  visibleLevels: 3,
  options: { ...DEFAULT_ABILITY_MAP_OPTIONS },
  selectedId: "data-literacy",
};

function mapStateFor(forest: AbilityForest): AbilityMapState {
  const stored = forest.mapState;
  if (!stored) return structuredClone(DEFAULT_MAP_STATE);
  return {
    ...DEFAULT_MAP_STATE,
    ...stored,
    pan: { ...DEFAULT_MAP_STATE.pan, ...stored.pan },
    options: { ...DEFAULT_MAP_STATE.options, ...stored.options },
    selectedId: stored.selectedId ?? null,
  };
}

function nodeColor(forest: AbilityForest, node: AbilityNode): string {
  let current = node;
  while (current.level > 0 && current.parentId) {
    current = forest.nodes.find((item) => item.id === current.parentId) ?? current;
  }
  return current.color ?? fallbackColor;
}

function descendantIds(forest: AbilityForest, rootId: string): Set<string> {
  const result = new Set<string>();
  const visit = (id: string) => {
    if (result.has(id)) return;
    result.add(id);
    childrenOf(forest, id).forEach((child) => visit(child.id));
  };
  visit(rootId);
  return result;
}

function orderedTree(forest: AbilityForest, collapsed: Set<string>) {
  const rows: Array<{ node: AbilityNode; depth: number; last: boolean }> = [];
  const walk = (node: AbilityNode, depth: number, last: boolean) => {
    rows.push({ node, depth, last });
    if (!collapsed.has(node.id)) {
      const children = childrenOf(forest, node.id);
      children.forEach((child, index) => walk(child, depth + 1, index === children.length - 1));
    }
  };
  orderedSiblings(forest, null).forEach((root, index, roots) => walk(root, 0, index === roots.length - 1));
  return rows;
}

export function AbilityForestView({ forest, saveState, onForestChange }: AbilityForestViewProps) {
  const initialMapState = mapStateFor(forest);
  const [selectedId, setSelectedId] = useState(initialMapState.selectedId ?? "data-literacy");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [seed, setSeed] = useState(initialMapState.seed);
  const [zoom, setZoom] = useState(initialMapState.zoom);
  const [mapPan, setMapPan] = useState(initialMapState.pan);
  const [visibleLevels, setVisibleLevels] = useState(initialMapState.visibleLevels);
  const [mapOptions, setMapOptions] = useState<AbilityMapOptions>(initialMapState.options);
  const [mapDrawer, setMapDrawer] = useState<"parameters" | "logs" | null>(null);
  const [previewPlants, setPreviewPlants] = useState<AbilityMapPlant[] | null>(null);
  const [collision, setCollision] = useState(false);
  const [collisionPreview, setCollisionPreview] = useState<{ x: number; y: number; size: number } | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [mapWidth, setMapWidth] = useState(initialMapState.mapWidth ?? 0);
  const [treeHeight, setTreeHeight] = useState(initialMapState.treeHeight ?? 0);
  const importInput = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapMetrics = useRef<AbilityMapMetrics | null>(null);
  const dragState = useRef<{ id: string | null; startX: number; startY: number; offsetX: number; offsetY: number; moved: boolean; x: number; y: number; panX: number; panY: number } | null>(null);
  const verticalSplitterRef = useRef<HTMLDivElement>(null);
  const horizontalSplitterRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const editorPanelRef = useRef<HTMLDivElement>(null);
  const splitterDrag = useRef<{ type: "vertical" | "horizontal"; startPos: number; startSize: number } | null>(null);
  const selected = selectedId ? forest.nodes.find((node) => node.id === selectedId) ?? orderedSiblings(forest, null)[0] : undefined;
  const rows = useMemo(() => orderedTree(forest, collapsed), [forest, collapsed]);
  const siblings = selected ? orderedSiblings(forest, selected.parentId) : [];
  const selectedIndex = selected ? siblings.findIndex((item) => item.id === selected.id) : -1;
  const selectedBranch = selected ? descendantIds(forest, selected.id) : new Set<string>();
  const descendantHeight = selected
    ? Math.max(0, ...[...selectedBranch].map((id) => (forest.nodes.find((node) => node.id === id)?.level ?? selected.level) - selected.level))
    : 0;
  const parentOptions = selected
    ? forest.nodes.filter((node) => node.level + 1 + descendantHeight <= 2 && !selectedBranch.has(node.id))
    : [];
  const rootNodes = orderedSiblings(forest, null);
  const layoutKey = forest.nodes.map((node) => `${node.id}:${node.parentId ?? ""}:${node.level}:${node.order}:${node.color ?? ""}`).join("|");
  const layoutForest = useMemo<AbilityForest>(() => ({
    schemaVersion: forest.schemaVersion,
    nodes: forest.nodes.map((node) => ({ ...node, name: node.id, markdown: "" })),
  // The isometric layout only depends on hierarchy, ordering, and root colors.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [layoutKey]);
  const mapModel = useMemo(() => generateAbilityMap(layoutForest, seed, mapOptions), [layoutForest, seed, mapOptions]);
  const positionedPlants = useMemo(() => mapModel.plants.map((plant) => ({ ...plant, ...(forest.mapPositions?.[plant.id] ?? {}) })), [mapModel, forest.mapPositions]);
  const canvasPlants = previewPlants ?? positionedPlants;

  useEffect(() => {
    const next = mapStateFor(forest);
    setSeed(next.seed);
    setZoom(next.zoom);
    setMapPan(next.pan);
    setVisibleLevels(next.visibleLevels);
    setMapOptions(next.options);
    setSelectedId(next.selectedId ?? "");
    setMapWidth(next.mapWidth ?? 0);
    setTreeHeight(next.treeHeight ?? 0);
  }, [forest.mapState]);

  useEffect(() => {
    if (mapWidth > 0) {
      document.documentElement.style.setProperty("--ability-map-width", `${mapWidth}px`);
    }
    if (treeHeight > 0) {
      document.documentElement.style.setProperty("--ability-tree-height", `${treeHeight}px`);
    }
  }, [mapWidth, treeHeight]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const drag = splitterDrag.current;
      if (!drag) return;

      if (drag.type === "vertical") {
        const deltaX = e.clientX - drag.startPos;
        const newWidth = Math.max(320, Math.min(drag.startSize + deltaX, window.innerWidth - 400));
        setMapWidth(newWidth);
        document.documentElement.style.setProperty("--ability-map-width", `${newWidth}px`);
      } else {
        const deltaY = e.clientY - drag.startPos;
        const panelHeight = editorPanelRef.current?.offsetHeight ?? 600;
        const newHeight = Math.max(140, Math.min(drag.startSize + deltaY, panelHeight - 260));
        setTreeHeight(newHeight);
        document.documentElement.style.setProperty("--ability-tree-height", `${newHeight}px`);
      }
    };

    const handleMouseUp = () => {
      const drag = splitterDrag.current;
      if (!drag) return;

      if (drag.type === "vertical") {
        document.body.classList.remove("dragging-vertical-splitter");
        verticalSplitterRef.current?.classList.remove("dragging");
        const finalWidth = mapWidth > 0 ? mapWidth : undefined;
        onForestChange({ ...forest, mapState: currentMapState({ mapWidth: finalWidth }) }, true);
      } else {
        document.body.classList.remove("dragging-horizontal-splitter");
        horizontalSplitterRef.current?.classList.remove("dragging");
        const finalHeight = treeHeight > 0 ? treeHeight : undefined;
        onForestChange({ ...forest, mapState: currentMapState({ treeHeight: finalHeight }) }, true);
      }

      splitterDrag.current = null;
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [forest, mapWidth, treeHeight, onForestChange]);

  useEffect(() => {
    setPreviewPlants(null);
    setCollision(false);
    setCollisionPreview(null);
  }, [mapModel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      mapMetrics.current = drawAbilityMap(canvas, forest, mapModel, canvasPlants, selected?.id ?? null, visibleLevels, zoom, mapPan, collisionPreview);
    };
    draw();
    if (typeof ResizeObserver !== "function") {
      window.addEventListener("resize", draw);
      return () => window.removeEventListener("resize", draw);
    }
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [forest, mapModel, canvasPlants, selected?.id, visibleLevels, zoom, mapPan, collisionPreview]);

  function currentMapState(overrides: Partial<AbilityMapState> = {}): AbilityMapState {
    return {
      seed,
      zoom,
      pan: mapPan,
      visibleLevels,
      options: mapOptions,
      selectedId: selectedId || null,
      mapWidth: mapWidth > 0 ? mapWidth : undefined,
      treeHeight: treeHeight > 0 ? treeHeight : undefined,
      ...overrides,
    };
  }

  function updateMapState(nextState: AbilityMapState, resetPositions = false) {
    setSeed(nextState.seed);
    setZoom(nextState.zoom);
    setMapPan(nextState.pan);
    setVisibleLevels(nextState.visibleLevels);
    setMapOptions(nextState.options);
    setSelectedId(nextState.selectedId ?? "");
    onForestChange({ ...forest, mapState: nextState, ...(resetPositions ? { mapPositions: {} } : {}) }, true);
  }

  function change(next: AbilityForest, immediate = false, mapState = currentMapState()) {
    setMessage(null);
    const ids = new Set(next.nodes.map((node) => node.id));
    const mapPositions = next.mapPositions
      ? Object.fromEntries(Object.entries(next.mapPositions).filter(([id]) => ids.has(id)))
      : undefined;
    onForestChange({ ...next, mapPositions, mapState }, immediate);
  }

  function addRoot() {
    const next = { ...createAbilityNode(forest), mapPositions: {} };
    const node = next.nodes.at(-1)!;
    change(next, true, currentMapState({ selectedId: node.id }));
    setSelectedId(node.id);
  }

  function addChild() {
    if (!selected || selected.level >= 2) return;
    const next = { ...createAbilityNode(forest, selected.id), mapPositions: {} };
    const node = next.nodes.at(-1)!;
    change(next, true, currentMapState({ selectedId: node.id }));
    setCollapsed((current) => {
      const copy = new Set(current);
      copy.delete(selected.id);
      return copy;
    });
    setSelectedId(node.id);
  }

  function updateName(name: string) {
    if (selected) change(renameAbilityNode(forest, selected.id, name));
  }

  function updateMarkdown(markdown: string) {
    if (selected) change(updateAbilityMarkdown(forest, selected.id, markdown));
  }

  function changeParent(parentId: string) {
    if (!selected) return;
    try {
      const next = { ...moveAbilityNode(forest, selected.id, parentId || null), mapPositions: {} };
      change(next, true);
      setMessage("节点位置已更新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法移动节点");
    }
  }

  function reorder(direction: -1 | 1) {
    if (selected) change(reorderAbilityNode(forest, selected.id, direction), true);
  }

  function selectNode(id: string | null) {
    setSelectedId(id ?? "");
    onForestChange({ ...forest, mapState: currentMapState({ selectedId: id }) }, true);
  }

  function removeSelected() {
    if (!selected) return;
    const count = selectedBranch.size;
    const detail = count > 1 ? `及其下属的 ${count - 1} 个节点` : "";
    if (deleteConfirmId !== selected.id) {
      setDeleteConfirmId(selected.id);
      setMessage(`再次点击确认删除「${selected.name}」${detail}，或点击取消。`);
      return;
    }
    try {
      const next = deleteAbilityNode(forest, selected.id);
      const nextId = selected.parentId ?? orderedSiblings(next, null)[0]?.id;
      setDeleteConfirmId(null);
      change(next, true, currentMapState({ selectedId: nextId ?? null }));
      setSelectedId(nextId ?? "");
      setMessage("节点及其说明已删除");
    } catch (error) {
      setDeleteConfirmId(null);
      setMessage(error instanceof Error ? error.message : "无法删除节点");
    }
  }

  function moveMapNode(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const metrics = mapMetrics.current;
    const drag = dragState.current;
    if (!canvas || !metrics || !drag) {
      if (canvas && metrics) {
        const point = eventToAbilityMapPoint(event, metrics);
        canvas.style.cursor = "grab";
      }
      return;
    }
    const point = eventToAbilityMapPoint(event, metrics);
    if (!drag.id) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (drag.moved) setMapPan({ x: drag.panX + dx, y: drag.panY + dy });
      return;
    }
    if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > 4) drag.moved = true;
    if (!drag.moved) return;
    const grid = abilityMapScreenToGrid(point.x, point.y);
    const x = Math.max(1, Math.min(mapModel.gridSize - 2, grid.x - drag.offsetX));
    const y = Math.max(1, Math.min(mapModel.gridSize - 2, grid.y - drag.offsetY));
    const plant = canvasPlants.find((item) => item.id === drag.id);
    if (!plant) return;
    const valid = abilityMapCanMove(plant, x, y, canvasPlants, mapModel.gridSize);
    setCollision(!valid);
    if (!valid) {
      setCollisionPreview({ x, y, size: plant.size });
      return;
    }
    setCollisionPreview(null);
    drag.x = x;
    drag.y = y;
    setPreviewPlants(canvasPlants.map((item) => item.id === drag.id ? { ...item, x, y } : item));
  }

  function finishMapPointer(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const drag = dragState.current;
    if (!drag) return;
    if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (drag.moved) {
      if (drag.id && !collision) {
        const positions = Object.fromEntries(canvasPlants.map((plant) => [plant.id, { x: plant.id === drag.id ? drag.x : plant.x, y: plant.id === drag.id ? drag.y : plant.y }]));
        onForestChange({ ...forest, mapPositions: positions, mapState: currentMapState() }, true);
        setMessage("树木位置已保存到本机");
      } else if (!drag.id) {
        const nextPan = { x: drag.panX + (event.clientX - drag.startX), y: drag.panY + (event.clientY - drag.startY) };
        updateMapState(currentMapState({ pan: nextPan }));
      }
      if (drag.id) setPreviewPlants(null);
    } else {
      if (drag.id) {
        const nextId = selectedId === drag.id ? null : drag.id;
        selectNode(nextId);
      }
    }
    dragState.current = null;
    setCollision(false);
    setCollisionPreview(null);
  }

  function startMapPointer(event: ReactPointerEvent<HTMLCanvasElement>) {
    const metrics = mapMetrics.current;
    if (!metrics) return;
    const point = eventToAbilityMapPoint(event, metrics);
    const id = abilityMapHitTest(point, metrics, canvasPlants);
    if (!id) {
      dragState.current = { id: null, startX: event.clientX, startY: event.clientY, offsetX: 0, offsetY: 0, moved: false, x: 0, y: 0, panX: mapPan.x, panY: mapPan.y };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const grid = abilityMapScreenToGrid(point.x, point.y);
    const plant = canvasPlants.find((item) => item.id === id) ?? nearestPlantAtGrid(grid.x, grid.y, canvasPlants);
    if (!plant) return;
    dragState.current = { id: plant.id, startX: point.x, startY: point.y, offsetX: grid.x - plant.x, offsetY: grid.y - plant.y, moved: false, x: plant.x, y: plant.y, panX: mapPan.x, panY: mapPan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function regenerateMap() {
    updateMapState(currentMapState({ seed: seed + 1 }), true);
  }

  function updateMapOption<K extends keyof AbilityMapOptions>(key: K, value: number) {
    updateMapState(currentMapState({ options: { ...mapOptions, [key]: value } }), true);
  }

  function startVerticalSplitterDrag(e: React.MouseEvent) {
    const currentWidth = layoutRef.current?.querySelector(".ability-map-panel")?.getBoundingClientRect().width ?? 600;
    splitterDrag.current = { type: "vertical", startPos: e.clientX, startSize: currentWidth };
    document.body.classList.add("dragging-vertical-splitter");
    verticalSplitterRef.current?.classList.add("dragging");
    e.preventDefault();
  }

  function startHorizontalSplitterDrag(e: React.MouseEvent) {
    const currentHeight = editorPanelRef.current?.querySelector(".ability-tree-section")?.getBoundingClientRect().height ?? 200;
    splitterDrag.current = { type: "horizontal", startPos: e.clientY, startSize: currentHeight };
    document.body.classList.add("dragging-horizontal-splitter");
    horizontalSplitterRef.current?.classList.add("dragging");
    e.preventDefault();
  }

  function exportJson() {
    const blob = new Blob([`${JSON.stringify(forest, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "ability-forest.json";
    link.click();
    URL.revokeObjectURL(url);
    setMessage("能力森林 JSON 已导出");
  }

  async function importJson(file: File | undefined) {
    if (!file) return;
    try {
      const next = parseAbilityForestJson(JSON.parse(await file.text()));
      if (!window.confirm(`导入 ${next.nodes.length} 个节点并替换当前能力森林？`)) return;
      const importedSelectedId = orderedSiblings(next, null)[0]?.id ?? "";
      change(next, true, next.mapState ?? currentMapState({ selectedId: importedSelectedId || null }));
      setSelectedId(next.mapState?.selectedId ?? importedSelectedId);
      setCollapsed(new Set());
      setMessage("JSON 已导入并保存到本机");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法导入 JSON 文件");
    } finally {
      if (importInput.current) importInput.current.value = "";
    }
  }

  const saveLabel = saveState === "saving" ? "正在保存" : saveState === "error" ? "保存失败" : "已保存到本机";

  return (
    <main className="ability-forest-page">
      <header className="ability-forest-header">
        <div className="ability-forest-heading">
          <span className="eyebrow">ABILITY FOREST · BETA · V4.3</span>
          <h2>能力森林</h2>
        </div>
        <p className="ability-forest-summary">{rootNodes.length} 个群落 · {forest.nodes.length} 项能力 · Seed {seed}</p>
        <div className="ability-forest-actions">
          <span className={`forest-save-state ${saveState}`} role="status" aria-live="polite">{saveLabel}</span>
          <button type="button" className={`secondary-button ${mapDrawer === "parameters" ? "is-open" : ""}`} onClick={() => setMapDrawer((current) => current === "parameters" ? null : "parameters")} aria-expanded={mapDrawer === "parameters"} title="地图生成参数">
            <Settings2 size={15} /> 地图参数
          </button>
          <button type="button" className={`secondary-button ${mapDrawer === "logs" ? "is-open" : ""}`} onClick={() => setMapDrawer((current) => current === "logs" ? null : "logs")} aria-expanded={mapDrawer === "logs"} title="查看地图生成日志">
            <ScrollText size={15} /> 生成日志
          </button>
          <button type="button" className="secondary-button" onClick={() => importInput.current?.click()} title="导入能力森林 JSON">
            <Upload size={15} /> 导入 JSON
          </button>
          <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={(event) => void importJson(event.target.files?.[0])} />
          <button type="button" className="secondary-button" onClick={exportJson} title="导出能力森林 JSON">
            <Download size={15} /> 导出 JSON
          </button>
          <button type="button" className="primary-button" onClick={addRoot}>
            <Plus size={15} /> 新建大节点
          </button>
        </div>
      </header>

      <div className="ability-forest-layout" ref={layoutRef}>
        <section className="ability-map-panel" aria-label="能力森林图">
          <div className="ability-map-scene">
            <canvas
              ref={canvasRef}
              className="ability-map-canvas"
              role="img"
              tabIndex={0}
              aria-label="能力森林等距地图。点击树木以编辑，拖动树木以移动位置。"
              onPointerDown={startMapPointer}
              onPointerMove={moveMapNode}
              onPointerUp={finishMapPointer}
              onPointerCancel={finishMapPointer}
            />
            <div className="ability-map-caption"><strong>ISOMETRIC 2.5D</strong><span>拖动树木重新安排位置 · 自动保存在本机</span></div>
            {collision && <div className="ability-map-collision" role="status">位置冲突，树木没有移动</div>}
            <div className="ability-map-tools" aria-label="森林显示控制">
              <button type="button" title="缩小" aria-label="缩小地图" onClick={() => updateMapState(currentMapState({ zoom: Math.max(0.65, Math.round((zoom - 0.1) * 10) / 10) }))}><ZoomOut size={15} /></button>
              <span className="ability-map-zoom">{Math.round(zoom * 100)}%</span>
              <button type="button" title="放大" aria-label="放大地图" onClick={() => updateMapState(currentMapState({ zoom: Math.min(1.4, Math.round((zoom + 0.1) * 10) / 10) }))}><ZoomIn size={15} /></button>
              <label className="sr-only" htmlFor="ability-map-levels">名称显示范围</label>
              <select id="ability-map-levels" aria-label="名称显示范围" value={visibleLevels} onChange={(event) => updateMapState(currentMapState({ visibleLevels: Number(event.target.value) }))}>
                <option value={3}>显示所有名称</option>
                <option value={2}>仅显示大中节点</option>
                <option value={1}>仅显示大节点</option>
                <option value={0}>隐藏所有名称</option>
              </select>
              <button type="button" title="重新生成地图" aria-label="重新生成地图" onClick={regenerateMap}><RotateCw size={14} /></button>
            </div>
            <div className="ability-map-legend" aria-label="树木大小表示节点层级"><span><i className="legend-root" />大节点</span><span><i className="legend-middle" />中节点</span><span><i className="legend-leaf" />小节点</span></div>
            {mapDrawer === "parameters" && (
              <section className="ability-map-drawer ability-map-parameters" aria-label="地图生成参数">
                <div className="ability-map-drawer-head"><strong>地图生成参数</strong><button type="button" className="icon-button" aria-label="关闭地图参数" onClick={() => setMapDrawer(null)}><Minus size={15} /></button></div>
                <div className="ability-map-seed"><span>当前种子</span><strong>{seed}</strong></div>
                {([
                  ["baseRadius", "大陆半径", 15, 35],
                  ["clusterSpread", "群落分散度", 4, 16],
                  ["largeNodeRadius", "大节点搜索半径", 5, 15],
                  ["mediumNodeRadius", "中节点搜索半径", 8, 20],
                ] as const).map(([key, label, min, max]) => (
                  <label className="ability-map-range" key={key}>
                    <span><span>{label}</span><strong>{mapOptions[key]}</strong></span>
                    <input type="range" min={min} max={max} value={mapOptions[key]} onChange={(event) => updateMapOption(key, Number(event.target.value))} aria-label={label} />
                  </label>
                ))}
                <p>调整参数会按当前能力关系重新生成海岸与树木布局。</p>
              </section>
            )}
            {mapDrawer === "logs" && (
              <section className="ability-map-drawer ability-map-logs" aria-label="地图生成日志">
                <div className="ability-map-drawer-head"><strong>地图生成日志</strong><button type="button" className="icon-button" aria-label="关闭生成日志" onClick={() => setMapDrawer(null)}><Minus size={15} /></button></div>
                <pre role="log" aria-live="polite">{mapModel.logs.map((line, index) => `[${String(index + 1).padStart(2, "0")}] ${line}`).join("\n")}</pre>
              </section>
            )}
          </div>
        </section>

        <div
          ref={verticalSplitterRef}
          className="ability-splitter-vertical"
          onMouseDown={startVerticalSplitterDrag}
          aria-label="调整地图宽度"
        />

        <aside className="ability-editor-panel" ref={editorPanelRef} aria-label="节点编辑器">
          <section className="ability-tree-section">
            <div className="ability-section-title"><h3>层级关系</h3><span>{forest.nodes.length} 个节点</span></div>
            <div className="ability-tree" role="tree" aria-label="能力节点层级">
              {rows.map(({ node, depth }) => {
                const childCount = childrenOf(forest, node.id).length;
                const hasChildren = childCount > 0;
                const color = nodeColor(forest, node);
                return (
                  <div className={`ability-tree-row ${depth === 0 ? "is-root" : ""} ${selectedId === node.id ? "is-selected" : ""}`} key={node.id} role="treeitem" aria-level={depth + 1} aria-selected={selectedId === node.id} aria-expanded={hasChildren ? !collapsed.has(node.id) : undefined} title={node.name} style={{ "--tree-depth": depth, "--node-color": color } as CSSProperties}>
                    {hasChildren ? (
                      <button type="button" className="tree-fold" aria-label={`${collapsed.has(node.id) ? "展开" : "折叠"}${node.name}`} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })}>{collapsed.has(node.id) ? "+" : "−"}</button>
                    ) : <span className="tree-fold-spacer" />}
                    <span className="tree-node-dot" aria-hidden="true" style={{ "--node-color": color } as CSSProperties} />
                    <button type="button" className="tree-node-label" onClick={() => selectNode(node.id)}>{node.name}</button>
                    {hasChildren && <span className="tree-child-count" aria-label={`${childCount} 个子节点`}>{childCount}</span>}
                  </div>
                );
              })}
            </div>
          </section>

          <div
            ref={horizontalSplitterRef}
            className="ability-splitter-horizontal"
            onMouseDown={startHorizontalSplitterDrag}
            aria-label="调整树状图高度"
          />

          {selected ? (
            <section className="ability-node-editor">
              <div className="ability-meta-line">
                <span className="ability-level-tag">{levelNames[selected.level]}</span>
                <span className="ability-meta-sep">·</span>
                <span className="ability-parent-path" title={selected.parentId ? parentOptions.find((n) => n.id === selected.parentId)?.name ?? "顶层" : "顶层"}>
                  {selected.parentId ? parentOptions.find((n) => n.id === selected.parentId)?.name ?? "顶层" : "顶层"}
                </span>
                <span className="ability-meta-sep">·</span>
                <div className="ability-order-controls-inline">
                  <button type="button" className="ability-order-btn" disabled={selectedIndex <= 0} onClick={() => reorder(-1)}>↑</button>
                  <span className="ability-order-value-inline">{selectedIndex + 1}/{siblings.length}</span>
                  <button type="button" className="ability-order-btn" disabled={selectedIndex < 0 || selectedIndex >= siblings.length - 1} onClick={() => reorder(1)}>↓</button>
                </div>
                {selected.level === 0 && (
                  <>
                    <span className="ability-meta-sep">·</span>
                    <div className="ability-color-dots">
                      {ABILITY_FOREST_COLORS.map((color) => (
                        <button
                          type="button"
                          key={color}
                          className={`ability-color-dot ${selected.color?.toUpperCase() === color ? "active" : ""}`}
                          style={{ "--swatch": color } as CSSProperties}
                          onClick={() => change(setAbilityNodeColor(forest, selected.id, color))}
                          aria-label={`选择${color === "#7FB77E" ? "绿色" : color === "#5A9FD4" ? "蓝色" : "珊瑚色"}`}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>

              <input
                className="ability-name-field"
                value={selected.name}
                maxLength={120}
                placeholder="节点名称"
                onChange={(event) => updateName(event.target.value)}
                onBlur={() => onForestChange(forest, true)}
                aria-label="节点名称"
              />

              <div className="ability-markdown-field-wrapper">
                <label className="ability-markdown-label">Markdown 说明</label>
                <textarea
                  className="ability-markdown-input"
                  value={selected.markdown}
                  onChange={(event) => updateMarkdown(event.target.value)}
                  onBlur={() => onForestChange(forest, true)}
                  spellCheck={false}
                  aria-label="Markdown 说明"
                />
              </div>

              <div className="ability-editor-actions">
                <button type="button" className="button" disabled={selected.level >= 2} onClick={addChild}>
                  ＋ 添加子节点
                </button>
                <button type="button" className="button primary" onClick={() => change(forest, true)}>
                  保存节点
                </button>
              </div>

              <div className="ability-delete-actions">
                <button type="button" className="ability-delete-button" onClick={removeSelected}>
                  <Trash2 size={14} /> {deleteConfirmId === selected.id ? "确认删除" : "删除节点"}
                </button>
                {deleteConfirmId === selected.id && (
                  <button type="button" className="ability-delete-cancel" onClick={() => { setDeleteConfirmId(null); setMessage(null); }}>
                    取消
                  </button>
                )}
              </div>

              {message && <p className="ability-editor-message" role="status">{message}</p>}
              {saveState === "error" && <p className="ability-editor-error" role="alert">保存失败。检查本机磁盘空间后再次保存。</p>}
            </section>
          ) : (
            <div className="ability-empty-editor"><FileJson size={24} /><span>从关系图中选择节点，开始编辑。</span></div>
          )}
        </aside>
      </div>
    </main>
  );
}
