import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Plus, RotateCcw, Search, Settings2, X } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { MEMORY_EMOTIONS, memoryStarSize, songMatchScore, splitMemoryLocations } from "../memoryLogic";
import type { EmotionType, LifeStage, Memory, MemoryMetadata } from "../types";

interface MemoryConstellationProps {
  memories: MemoryMetadata[];
  previewIntensity: { id: string; intensity: number } | null;
  lifeStages: LifeStage[];
  selectedMemory: Memory | null;
  songQuery: string;
  selectedEmotions: EmotionType[];
  selectedLocations: string[];
  locations: string[];
  onToggleEmotion: (emotion: EmotionType) => void;
  onToggleLocation: (location: string) => void;
  onSongQueryChange: (query: string) => void;
  onResetFilters: () => void;
  onMemoryClick: (memory: MemoryMetadata) => void | Promise<void>;
  onNewMemory: () => void;
}

const EMOTION_COLORS: Record<string, number> = {
  nostalgic: 0xe9a568,
  melancholic: 0x3b6dff,
  excited: 0x38bdf8,
  calm: 0x6ee7b7,
  confused: 0x9ca3af,
  warm: 0xf97316,
};

interface ConstellationParams {
  starSizeBase: number;
  starSizeIntensity: number;
  bgStarMultiplier: number;
  bgOpacity: number;
  nodeOpacity: number;
  zThicknessMultiplier: number;
  cameraMoveSpeed: number;
  dampingFactor: number;
}

const DEFAULT_PARAMS: ConstellationParams = {
  starSizeBase: 2,
  starSizeIntensity: 2,
  bgStarMultiplier: 1,
  bgOpacity: 0.18,
  nodeOpacity: 0.5,
  zThicknessMultiplier: 1,
  cameraMoveSpeed: 1200,
  dampingFactor: 0.05,
};

const PARAMETER_CONTROLS: { key: keyof ConstellationParams; label: string; min: number; max: number; step: number }[] = [
  { key: "starSizeBase", label: "星星基础大小", min: 1, max: 5, step: 0.1 },
  { key: "starSizeIntensity", label: "情绪强度系数", min: 0, max: 4, step: 0.1 },
  { key: "bgStarMultiplier", label: "星云粒子倍数", min: 0.5, max: 3, step: 0.1 },
  { key: "bgOpacity", label: "星云不透明度", min: 0.05, max: 0.5, step: 0.01 },
  { key: "nodeOpacity", label: "节点星云不透明度", min: 0.1, max: 0.8, step: 0.05 },
  { key: "zThicknessMultiplier", label: "Z 轴厚度", min: 0.5, max: 2, step: 0.1 },
  { key: "cameraMoveSpeed", label: "相机速度 (ms)", min: 600, max: 2400, step: 100 },
  { key: "dampingFactor", label: "阻尼系数", min: 0.01, max: 0.2, step: 0.01 },
];

const PARAMS_STORAGE_KEY = "memory-constellation-v11-state";
const SONG_RESULT_LIMIT = 8;

function loadConstellationParams(): ConstellationParams {
  if (typeof window === "undefined") return DEFAULT_PARAMS;
  try {
    const saved = window.localStorage.getItem(PARAMS_STORAGE_KEY);
    if (!saved) return DEFAULT_PARAMS;
    const state = JSON.parse(saved) as { params?: Partial<ConstellationParams> };
    const restored = { ...DEFAULT_PARAMS };
    PARAMETER_CONTROLS.forEach(({ key, min, max }) => {
      const value = state.params?.[key];
      if (typeof value === "number" && Number.isFinite(value)) restored[key] = Math.max(min, Math.min(max, value));
    });
    return restored;
  } catch {
    return DEFAULT_PARAMS;
  }
}

export function MemoryConstellation({
  memories,
  previewIntensity,
  lifeStages,
  selectedMemory,
  songQuery,
  selectedEmotions,
  selectedLocations,
  locations,
  onToggleEmotion,
  onToggleLocation,
  onSongQueryChange,
  onResetFilters,
  onMemoryClick,
  onNewMemory,
}: MemoryConstellationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    scene: THREE.Scene;
    zoomToStage: (name: string) => void;
    focusMemory: (id: string) => void;
    returnToGlobal: () => void;
    setDamping: (value: number) => void;
  } | null>(null);
  const activeStageRef = useRef<string | null>(null);
  const selectedMemoryRef = useRef(selectedMemory);
  selectedMemoryRef.current = selectedMemory;
  const [params, setParams] = useState<ConstellationParams>(loadConstellationParams);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [hoveredMemory, setHoveredMemory] = useState<{ song: string; date: string; x: number; y: number } | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    try {
      window.localStorage.setItem(PARAMS_STORAGE_KEY, JSON.stringify({ params }));
    } catch {
      // Storage may be unavailable in private or embedded browser contexts.
    }
  }, [params]);

  useEffect(() => {
    const mountedContainer = containerRef.current;
    if (!mountedContainer) return;
    const container: HTMLDivElement = mountedContainer;

    let disposed = false;

    // ========== 初始化场景 ==========
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x000000, 0.001);

    const initialWidth = Math.max(container.clientWidth, 1);
    const initialHeight = Math.max(container.clientHeight, 1);

    const camera = new THREE.PerspectiveCamera(
      60,
      initialWidth / initialHeight,
      0.1,
      1000,
    );
    camera.position.set(0, 60, 250);
    camera.lookAt(0, 0, 114);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(initialWidth, initialHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = paramsRef.current.dampingFactor;
    controls.minDistance = 10;
    controls.maxDistance = 400;
    controls.enablePan = true;
    controls.panSpeed = 0.8;
    controls.rotateSpeed = 0.5;
    controls.target.set(0, 0, 114);
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    // ========== 创建星星纹理 ==========
    function createStarTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 512;
      const ctx = canvas.getContext("2d")!;
      const centerX = 256;
      const centerY = 256;
      const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, 256);
      gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
      gradient.addColorStop(0.15, "rgba(255, 255, 255, 0.9)");
      gradient.addColorStop(0.35, "rgba(255, 255, 255, 0.5)");
      gradient.addColorStop(0.6, "rgba(255, 255, 255, 0.1)");
      gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 512, 512);
      return new THREE.CanvasTexture(canvas);
    }

    const starTexture = createStarTexture();

    // ========== 扩展 LifeStage 类型 ==========
    type ExtendedLifeStage = LifeStage & {
      zStart: number;
      zEnd: number;
      centerPos: THREE.Vector3;
    };

    const stageTimestamp = (value: string) => {
      const normalized = value.replace(/\./g, "-");
      const match = normalized.match(/^(\d{4})-(\d{1,2})/);
      if (!match) return Number.NaN;
      return Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
    };
    const timelineDates = lifeStages.flatMap((stage) => [stageTimestamp(stage.start), stageTimestamp(stage.end)]).filter(Number.isFinite);
    const timelineStart = timelineDates.length ? Math.min(...timelineDates) : Date.UTC(2007, 8, 1);
    const timelineDuration = Math.max((timelineDates.length ? Math.max(...timelineDates) : Date.UTC(2027, 7, 1)) - timelineStart, 1);
    const toTimelineZ = (timestamp: number) => 228 - ((timestamp - timelineStart) / timelineDuration) * 228;

    const extendedStages: ExtendedLifeStage[] = lifeStages.map((stage) => {
      const start = stageTimestamp(stage.start);
      const end = stageTimestamp(stage.end);
      return {
        ...stage,
        zStart: Number.isFinite(start) ? toTimelineZ(start) : 114,
        zEnd: Number.isFinite(end) ? toTimelineZ(end) : 114,
        centerPos: new THREE.Vector3(0, 0, 0),
      };
    });

    // ========== 创建时间线管 ==========
    const tubeControlPoints: THREE.Vector3[] = [];
    extendedStages.forEach((stage, i) => {
      const zCenter = (stage.zStart + stage.zEnd) / 2;
      const offsetX = Math.sin(i * 1.5) * 4 + (Math.random() - 0.5) * 2;
      const offsetY = Math.cos(i * 1.3) * 4 + (Math.random() - 0.5) * 2;
      const centerPos = new THREE.Vector3(offsetX, offsetY, zCenter);
      tubeControlPoints.push(centerPos);
      stage.centerPos = centerPos;

      if (i < extendedStages.length - 1) {
        const nextStage = extendedStages[i + 1];
        const midZ = (stage.zEnd + nextStage.zStart) / 2;
        const midOffsetX = (offsetX + Math.sin((i + 0.5) * 1.5) * 4) / 2;
        const midOffsetY = (offsetY + Math.cos((i + 0.5) * 1.3) * 4) / 2;
        tubeControlPoints.push(
          new THREE.Vector3(midOffsetX + (Math.random() - 0.5) * 4, midOffsetY + (Math.random() - 0.5) * 4, midZ),
        );
      }
    });

    if (tubeControlPoints.length >= 2) {
      const tubeCurve = new THREE.CatmullRomCurve3(tubeControlPoints);
      const tubeGeometry = new THREE.TubeGeometry(tubeCurve, 200, 0.2, 8, false);
      const tubeMaterial = new THREE.MeshBasicMaterial({ color: 0x6366f1, transparent: true, opacity: 0.25 });
      scene.add(new THREE.Mesh(tubeGeometry, tubeMaterial));
    }

    // ========== 创建阶段节点和节点星云 ==========
    extendedStages.forEach((stage, i) => {
      const pos = stage.centerPos;

      const node = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x818cf8, transparent: true, opacity: 0.8 }),
      );
      node.position.copy(pos);
      scene.add(node);

      // 节点星云参数
      const nodeGalaxyParams = {
        a: 0.7 + i * 0.16 + (Math.random() - 0.5) * 0.2,
        b: 0.18 + i * 0.06 + (Math.random() - 0.5) * 0.07,
        armCount: 2 + (i % 4),
        armAngles: Array.from({ length: 6 }, () => Math.random() * Math.PI * 2),
        armLengthFactor: 1.2 + i * 0.24 + Math.random() * 0.4,
        ellipseX: 1.4 + i * 0.2 + (Math.random() - 0.5) * 0.25,
        ellipseY: 1.2 + i * 0.15 + (Math.random() - 0.5) * 0.2,
        rotationAngle: (i * Math.PI) / 5 + (Math.random() - 0.5) * (Math.PI / 6),
        color: new THREE.Color().setHSL(0.52 + i * 0.08 + (Math.random() - 0.5) * 0.1, 0.7, 0.55),
        zThicknessBase: 1.8 + i * 0.4 + (Math.random() - 0.5) * 0.5,
        zThicknessNoise: 0.8 + (Math.random() - 0.5) * 0.4,
      };

      const nodeStarCount = 700;
      const nodePositions = new Float32Array(nodeStarCount * 3);
      const nodeColors = new Float32Array(nodeStarCount * 3);
      const nodeSizes = new Float32Array(nodeStarCount);

      for (let j = 0; j < nodeStarCount; j++) {
        const armIdx = j % nodeGalaxyParams.armCount;
        const t = (j / nodeStarCount) * nodeGalaxyParams.armLengthFactor * 8;
        const angle = nodeGalaxyParams.armAngles[armIdx] + t * Math.PI * 2.5;
        const baseRadius = nodeGalaxyParams.a * Math.exp(nodeGalaxyParams.b * t);

        const radialRatio = t / 8;
        const radialThickness = baseRadius * (0.35 + radialRatio * 0.2);
        const perpAngle = Math.random() * Math.PI * 2;
        const perpDist = (Math.random() - 0.5) * radialThickness * (1 + (Math.random() - 0.5) * 0.5);

        let x = Math.cos(angle) * (baseRadius + Math.cos(perpAngle) * perpDist) * nodeGalaxyParams.ellipseX;
        let y = Math.sin(angle) * (baseRadius + Math.sin(perpAngle) * perpDist) * nodeGalaxyParams.ellipseY;

        const cosR = Math.cos(nodeGalaxyParams.rotationAngle);
        const sinR = Math.sin(nodeGalaxyParams.rotationAngle);
        const xRot = x * cosR - y * sinR;
        const yRot = x * sinR + y * cosR;

        const zThicknessScale = nodeGalaxyParams.zThicknessBase * (1 + radialRatio * 0.5);
        const zNoise = (Math.random() - 0.5) * nodeGalaxyParams.zThicknessNoise;
        const zOffset = (Math.random() - 0.5) * zThicknessScale * (1 + zNoise);

        nodePositions[j * 3] = xRot + pos.x;
        nodePositions[j * 3 + 1] = yRot + pos.y;
        nodePositions[j * 3 + 2] = pos.z + zOffset;

        nodeColors[j * 3] = nodeGalaxyParams.color.r * (0.6 + Math.random() * 0.4);
        nodeColors[j * 3 + 1] = nodeGalaxyParams.color.g * (0.6 + Math.random() * 0.4);
        nodeColors[j * 3 + 2] = nodeGalaxyParams.color.b * (0.6 + Math.random() * 0.4);

        nodeSizes[j] = 1.0 + Math.random() * 2.0;
      }

      const nodeGalaxyGeometry = new THREE.BufferGeometry();
      nodeGalaxyGeometry.setAttribute("position", new THREE.BufferAttribute(nodePositions, 3));
      nodeGalaxyGeometry.setAttribute("color", new THREE.BufferAttribute(nodeColors, 3));
      nodeGalaxyGeometry.setAttribute("size", new THREE.BufferAttribute(nodeSizes, 1));

      const nodeGalaxyMaterial = new THREE.PointsMaterial({
        vertexColors: true,
        transparent: true,
        opacity: params.nodeOpacity,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
        map: starTexture,
        depthWrite: false,
      });

      scene.add(new THREE.Points(nodeGalaxyGeometry, nodeGalaxyMaterial));
    });

    // ========== 创建星系 (每个阶段一个) ==========
    const galaxies: THREE.Group[] = [];
    const galaxyBoundingBoxes: THREE.Mesh[] = [];

    function createGalaxies() {
      // 清理旧的
      galaxies.forEach((g) => scene.remove(g));
      galaxies.length = 0;
      galaxyBoundingBoxes.forEach((b) => scene.remove(b));
      galaxyBoundingBoxes.length = 0;

      extendedStages.forEach((stage) => {
      const stageMemories = memories.filter((memory) => memoryBelongsToStage(memory, stage));
        const galaxyGroup = new THREE.Group();
        galaxyGroup.userData = { type: "galaxy", stage, memories: stageMemories };

        // 螺旋星系参数
        const spiralParams = {
          a: 0.7 + Math.random() * 0.8,
          b: 0.22 + Math.random() * 0.3,
          armCount: 2 + Math.floor(Math.random() * 4),
          armAngles: Array.from({ length: 6 }, () => Math.random() * Math.PI * 2),
          armLengths: Array.from({ length: 6 }, () => 0.9 + Math.random() * 0.7),
          ellipseX: 1.5 + Math.random() * 1.0,
          ellipseY: 1.0 + Math.random() * 0.8,
          rotationAngle: (Math.random() - 0.5) * (Math.PI / 3),
          maxRadius: 16 + Math.random() * 8,
          zThicknessCenter: 12 + Math.random() * 16,
          zThicknessEdge: 4 + Math.random() * 5,
          zThicknessNoiseScale: 0.4 + Math.random() * 0.6,
        };

        // 背景星云
        const bgStarCount = Math.floor(8400 * params.bgStarMultiplier);
        const bgPositions = new Float32Array(bgStarCount * 3);
        const bgColors = new Float32Array(bgStarCount * 3);
        const bgSizes = new Float32Array(bgStarCount);

        for (let i = 0; i < bgStarCount; i++) {
          const armIdx = i % spiralParams.armCount;
          const t = (i / bgStarCount) * spiralParams.armLengths[armIdx] * 12;
          const angle = spiralParams.armAngles[armIdx] + t * Math.PI * 2;
          const baseRadius = spiralParams.a * Math.exp(spiralParams.b * t);

          const radialRatio = Math.min(t / 10, 1);
          const radialThickness = Math.sqrt(1 - radialRatio ** 2) * baseRadius * 0.9;
          const perpAngle = Math.random() * Math.PI * 2;
          const perpDist = (Math.random() - 0.5) * radialThickness;

          let x = Math.cos(angle) * (baseRadius + Math.cos(perpAngle) * perpDist) * spiralParams.ellipseX;
          let y = Math.sin(angle) * (baseRadius + Math.sin(perpAngle) * perpDist) * spiralParams.ellipseY;

          const cosR = Math.cos(spiralParams.rotationAngle);
          const sinR = Math.sin(spiralParams.rotationAngle);
          const xRot = x * cosR - y * sinR;
          const yRot = x * sinR + y * cosR;

          const zThicknessLinear =
            spiralParams.zThicknessCenter * (1 - radialRatio * 0.75) + spiralParams.zThicknessEdge * radialRatio;
          const randomFactor = 1 + (Math.random() - 0.5) * spiralParams.zThicknessNoiseScale * (1 - radialRatio * 0.3);
          const zThickness = zThicknessLinear * randomFactor * params.zThicknessMultiplier;
          const zOffset = (Math.random() - 0.5) * zThickness;

          bgPositions[i * 3] = xRot + stage.centerPos.x;
          bgPositions[i * 3 + 1] = yRot + stage.centerPos.y;
          bgPositions[i * 3 + 2] = stage.centerPos.z + zOffset;

          const brightness = 0.08 + Math.random() * 0.15;
          bgColors[i * 3] = brightness * 0.4;
          bgColors[i * 3 + 1] = brightness * 0.5;
          bgColors[i * 3 + 2] = brightness * 0.7;
          bgSizes[i] = Math.random() * 0.6 + 0.2;
        }

        const bgGeometry = new THREE.BufferGeometry();
        bgGeometry.setAttribute("position", new THREE.BufferAttribute(bgPositions, 3));
        bgGeometry.setAttribute("color", new THREE.BufferAttribute(bgColors, 3));
        bgGeometry.setAttribute("size", new THREE.BufferAttribute(bgSizes, 1));

        const bgMaterial = new THREE.PointsMaterial({
          vertexColors: true,
          transparent: true,
          opacity: params.bgOpacity,
          sizeAttenuation: true,
          blending: THREE.AdditiveBlending,
          map: starTexture,
          depthWrite: false,
        });

        galaxyGroup.add(new THREE.Points(bgGeometry, bgMaterial));

        // 记忆星星
        const convexHullPoints: THREE.Vector3[] = [];
        const galaxyMemorySprites: THREE.Sprite[] = [];

        stageMemories.forEach((memory) => {
          const locPos = getLocationBasePosition(memory.location);
          const memZ = dateToZ(memory.date, stage);

          const x = locPos.x + stage.centerPos.x + (Math.random() - 0.5) * 2;
          const y = locPos.y + stage.centerPos.y + (Math.random() - 0.5) * 2;
          const z = memZ + (Math.random() - 0.5) * 2;

          convexHullPoints.push(new THREE.Vector3(x, y, z));

          const canvas = document.createElement("canvas");
          canvas.width = 256;
          canvas.height = 256;
          const ctx = canvas.getContext("2d")!;
          const centerX = 128;
          const centerY = 128;

          const color = new THREE.Color(EMOTION_COLORS[memory.emotion.type]);
          const r = Math.floor(color.r * 255);
          const g = Math.floor(color.g * 255);
          const b = Math.floor(color.b * 255);

          const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, 128);
          gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
          gradient.addColorStop(0.2, `rgba(${r}, ${g}, ${b}, 0.9)`);
          gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.5)`);
          gradient.addColorStop(0.8, `rgba(${r}, ${g}, ${b}, 0.1)`);
          gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, 256, 256);

          const texture = new THREE.CanvasTexture(canvas);
          const spriteMaterial = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });

          const sprite = new THREE.Sprite(spriteMaterial);
          sprite.position.set(x, y, z);

          const baseScale = memoryStarSize(memory.emotion.intensity, params.starSizeBase, params.starSizeIntensity);
          sprite.scale.set(baseScale, baseScale, 1);

          sprite.userData = { type: "memory-star", memory, baseScale };
          galaxyGroup.add(sprite);
          galaxyMemorySprites.push(sprite);
        });

        galaxyGroup.userData.memorySprites = galaxyMemorySprites;

        const centerZ = (stage.zStart + stage.zEnd) / 2;
        const hullPoints = convexHullPoints.length >= 4
          ? convexHullPoints.map((point) => {
            const center = new THREE.Vector3(stage.centerPos.x, stage.centerPos.y, centerZ);
            const direction = point.clone().sub(center).normalize();
            return point.clone().add(direction.multiplyScalar(6));
          })
          : [...convexHullPoints];
        if (hullPoints.length < 4) {
          const radius = stageMemories.length > 0 ? 10 : 16;
          const depth = Math.max(6, Math.abs(stage.zStart - stage.zEnd) * 0.32);
          for (let point = 0; point < 8; point++) {
            const angle = (point / 8) * Math.PI * 2;
            const wobble = 0.82 + ((point * 17) % 5) * 0.075;
            hullPoints.push(new THREE.Vector3(
              stage.centerPos.x + Math.cos(angle) * radius * wobble,
              stage.centerPos.y + Math.sin(angle) * radius * (1.2 - wobble * 0.25),
              centerZ + Math.sin(angle * 1.7) * depth,
            ));
          }
        }

        try {
          const convexGeometry = new ConvexGeometry(hullPoints);
          const edges = new THREE.EdgesGeometry(convexGeometry);
          const lineMaterial = new THREE.LineDashedMaterial({
            color: 0x6366f1,
            transparent: true,
            opacity: 0.3,
            dashSize: 0.8,
            gapSize: 0.4,
          });
          const boundary = new THREE.LineSegments(edges, lineMaterial);
          boundary.computeLineDistances();
          galaxyGroup.add(boundary);

          const hoverMesh = new THREE.Mesh(
            convexGeometry,
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
          );
          hoverMesh.userData = { type: "galaxy-hitbox", galaxy: galaxyGroup };
          galaxyGroup.add(hoverMesh);
          galaxyBoundingBoxes.push(hoverMesh);
        } catch (error) {
          console.warn("星云边界生成失败:", stage.name, error);
        }

        scene.add(galaxyGroup);
        galaxies.push(galaxyGroup);
      });
    }

    createGalaxies();

    const timeAxisObjects: THREE.Object3D[] = [];
    function disposeObject(object: THREE.Object3D) {
      const renderable = object as THREE.Object3D & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      renderable.geometry?.dispose();
      const materials = renderable.material
        ? Array.isArray(renderable.material) ? renderable.material : [renderable.material]
        : [];
      materials.forEach((material) => {
        (material as THREE.Material & { map?: THREE.Texture }).map?.dispose();
        material.dispose();
      });
    }

    function removeTimeAxis() {
      timeAxisObjects.forEach((object) => {
        scene.remove(object);
        disposeObject(object);
      });
      timeAxisObjects.length = 0;
    }

    function createTimeAxis(stage: ExtendedLifeStage) {
      removeTimeAxis();
      const axisGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, stage.zStart),
        new THREE.Vector3(0, 0, stage.zEnd),
      ]);
      const axis = new THREE.Line(axisGeometry, new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.6, transparent: true }));
      scene.add(axis);
      timeAxisObjects.push(axis);

      const start = stage.start.replace(/\./g, "-").match(/^(\d{4})-(\d{1,2})/);
      const end = stage.end.replace(/\./g, "-").match(/^(\d{4})-(\d{1,2})/);
      if (!start || !end) return;
      const startDate = new Date(Date.UTC(Number(start[1]), Number(start[2]) - 1, 1));
      const endDate = new Date(Date.UTC(Number(end[1]), Number(end[2]) - 1, 1));
      let year = startDate.getUTCFullYear();
      if (startDate.getUTCMonth() > 0) year += 1;
      while (Date.UTC(year, 0, 1) <= endDate.getTime()) {
        const z = dateToZ(`${year}Q1`, stage);
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(0.6, 16, 16),
          new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.8, transparent: true }),
        );
        marker.position.set(0, 0, z);
        scene.add(marker);
        timeAxisObjects.push(marker);

        const labelCanvas = document.createElement("canvas");
        labelCanvas.width = 128;
        labelCanvas.height = 64;
        const context = labelCanvas.getContext("2d");
        if (context) {
          context.fillStyle = "#ffffff";
          context.font = "bold 32px sans-serif";
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillText(String(year), 64, 32);
          const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(labelCanvas), transparent: true }));
          label.position.set(2, 0, z);
          label.scale.set(4, 2, 1);
          scene.add(label);
          timeAxisObjects.push(label);
        }
        year += 1;
      }
    }

    // ========== 鼠标交互 ==========
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let currentView = "global";
    let hoveredGalaxy: THREE.Group | null = null;
    let hoveredMemorySprite: THREE.Sprite | null = null;
    let selectedGalaxy: THREE.Group | null = null;
    let cameraMotionFrame: number | null = null;

    function setHoveredSprite(sprite: THREE.Sprite | null, event?: MouseEvent) {
      if (hoveredMemorySprite && hoveredMemorySprite !== sprite) {
        const previousMemory = hoveredMemorySprite.userData.memory as MemoryMetadata | undefined;
        const isSelected = previousMemory?.id === selectedMemoryRef.current?.id;
        (hoveredMemorySprite.material as THREE.SpriteMaterial).opacity = isSelected ? 1 : 0.82;
        const previousScale = hoveredMemorySprite.userData.baseScale as number | undefined;
        if (previousScale) {
          const scale = previousScale * (isSelected ? 1.4 : 1);
          hoveredMemorySprite.scale.set(scale, scale, 1);
        }
      }
      hoveredMemorySprite = sprite;
      if (!sprite) {
        setHoveredMemory(null);
        return;
      }
      const memory = sprite.userData.memory as MemoryMetadata | undefined;
      const baseScale = sprite.userData.baseScale as number | undefined;
      const isSelected = memory?.id === selectedMemoryRef.current?.id;
      (sprite.material as THREE.SpriteMaterial).opacity = 1;
      if (baseScale) {
        const scale = baseScale * (isSelected ? 1.6 : 1.35);
        sprite.scale.set(scale, scale, 1);
      }
      if (memory && event && containerRef.current) {
        const bounds = containerRef.current.getBoundingClientRect();
        setHoveredMemory({ song: memory.song || "未命名记忆", date: memory.date, x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      }
    }

    function onMouseMove(event: MouseEvent) {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      if (currentView === "global") {
        setHoveredSprite(null);
        const intersects = raycaster.intersectObjects(galaxyBoundingBoxes);
        if (intersects.length > 0) {
          const galaxy = intersects[0].object.userData.galaxy as THREE.Group;
          if (hoveredGalaxy !== galaxy) {
            if (hoveredGalaxy) resetGalaxyHighlight(hoveredGalaxy);
            hoveredGalaxy = galaxy;
            highlightGalaxy(galaxy);
            renderer.domElement.style.cursor = "pointer";
          }
        } else if (hoveredGalaxy) {
          resetGalaxyHighlight(hoveredGalaxy);
          hoveredGalaxy = null;
          renderer.domElement.style.cursor = "default";
        }
      } else {
        const sprites = selectedGalaxy?.userData.memorySprites as THREE.Sprite[] | undefined;
        const hit = sprites ? raycaster.intersectObjects(sprites)[0]?.object as THREE.Sprite | undefined : undefined;
        setHoveredSprite(hit ?? null, hit ? event : undefined);
        renderer.domElement.style.cursor = hit ? "pointer" : "default";
      }
    }

    function onMouseLeave() {
      if (hoveredGalaxy) resetGalaxyHighlight(hoveredGalaxy);
      hoveredGalaxy = null;
      setHoveredSprite(null);
      renderer.domElement.style.cursor = "default";
    }

    function highlightGalaxy(galaxy: THREE.Group) {
      galaxy.children.forEach((child) => {
        if (child instanceof THREE.Points) {
          child.material.opacity = 0.4;
        } else if (child instanceof THREE.LineSegments) {
          child.material.opacity = 0.9;
        }
      });
    }

    function resetGalaxyHighlight(galaxy: THREE.Group) {
      galaxy.children.forEach((child) => {
        if (child instanceof THREE.Points) {
          child.material.opacity = params.bgOpacity;
        } else if (child instanceof THREE.LineSegments) {
          child.material.opacity = 0.3;
        }
      });
    }

    function onMouseClick(event: MouseEvent) {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      if (currentView === "global") {
        const intersects = raycaster.intersectObjects(galaxyBoundingBoxes);
        if (intersects.length > 0) {
          const galaxy = intersects[0].object.userData.galaxy as THREE.Group;
          zoomToGalaxy(galaxy);
        }
      } else if (selectedGalaxy) {
        const sprites = selectedGalaxy.userData.memorySprites as THREE.Sprite[];
        const memoryHit = raycaster.intersectObjects(sprites);
        const memory = memoryHit[0]?.object.userData.memory as MemoryMetadata | undefined;
        if (memory) onMemoryClick(memory);
      }
    }

    function animateCamera(
      startPos: THREE.Vector3,
      startTarget: THREE.Vector3,
      endPos: THREE.Vector3,
      endTarget: THREE.Vector3,
      duration: number,
    ) {
      const startTime = Date.now();
      if (cameraMotionFrame !== null) cancelAnimationFrame(cameraMotionFrame);
      function animate() {
        if (disposed) return;
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;

        camera.position.lerpVectors(startPos, endPos, eased);
        controls.target.lerpVectors(startTarget, endTarget, eased);

        if (progress < 1) cameraMotionFrame = requestAnimationFrame(animate);
        else cameraMotionFrame = null;
      }
      animate();
    }

    function zoomToGalaxy(galaxy: THREE.Group) {
      currentView = "stage";
      if (hoveredGalaxy) resetGalaxyHighlight(hoveredGalaxy);
      hoveredGalaxy = null;
      selectedGalaxy = galaxy;
      const stage = galaxy.userData.stage as ExtendedLifeStage;
      activeStageRef.current = stage.name;
      setActiveStage(stage.name);
      setHoveredMemory(null);
      const centerZ = (stage.zStart + stage.zEnd) / 2;
      const endPos = new THREE.Vector3(stage.centerPos.x, stage.centerPos.y + 30, centerZ + 40);
      const endTarget = new THREE.Vector3(stage.centerPos.x, stage.centerPos.y, centerZ);

      createTimeAxis(stage);
      animateCamera(camera.position.clone(), controls.target.clone(), endPos, endTarget, paramsRef.current.cameraMoveSpeed);
    }

    function zoomToStage(name: string) {
      const galaxy = galaxies.find((item) => (item.userData.stage as ExtendedLifeStage).name === name);
      if (galaxy) zoomToGalaxy(galaxy);
    }

    function focusMemory(id: string) {
      const galaxy = galaxies.find((item) => (item.userData.memories as MemoryMetadata[]).some((memory) => memory.id === id));
      if (galaxy && galaxy !== selectedGalaxy) zoomToGalaxy(galaxy);
    }

    function returnToGlobal() {
      if (currentView === "global") return;
      currentView = "global";
      selectedGalaxy = null;
      if (hoveredGalaxy) resetGalaxyHighlight(hoveredGalaxy);
      hoveredGalaxy = null;
      activeStageRef.current = null;
      setActiveStage(null);
      setHoveredMemory(null);
      removeTimeAxis();
      const endPos = new THREE.Vector3(0, 60, 250);
      const endTarget = new THREE.Vector3(0, 0, 114);

      animateCamera(camera.position.clone(), controls.target.clone(), endPos, endTarget, paramsRef.current.cameraMoveSpeed);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && currentView === "stage") {
        returnToGlobal();
      }
    }

    renderer.domElement.addEventListener("mousemove", onMouseMove);
    renderer.domElement.addEventListener("mouseleave", onMouseLeave);
    renderer.domElement.addEventListener("click", onMouseClick);
    document.addEventListener("keydown", onKeyDown);
    sceneRef.current = { scene, zoomToStage, focusMemory, returnToGlobal, setDamping: (value) => { controls.dampingFactor = value; } };
    if (activeStageRef.current) zoomToStage(activeStageRef.current);

    // ========== 动画循环 ==========
    function animate() {
      if (disposed) return;
      requestAnimationFrame(animate);
      galaxies.forEach((g) => (g.rotation.z += 0.0002));
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    // ========== 窗口调整 ==========
    function onResize() {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    }
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("mousemove", onMouseMove);
      renderer.domElement.removeEventListener("mouseleave", onMouseLeave);
      renderer.domElement.removeEventListener("click", onMouseClick);
      document.removeEventListener("keydown", onKeyDown);
      if (cameraMotionFrame !== null) cancelAnimationFrame(cameraMotionFrame);
      removeTimeAxis();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      const textures = new Set<THREE.Texture>();
      scene.traverse((object) => {
        const renderable = object as THREE.Object3D & {
          geometry?: THREE.BufferGeometry;
          material?: THREE.Material | THREE.Material[];
        };
        if (renderable.geometry) geometries.add(renderable.geometry);
        const objectMaterials = renderable.material
          ? Array.isArray(renderable.material) ? renderable.material : [renderable.material]
          : [];
        objectMaterials.forEach((material) => {
          materials.add(material);
          const texture = (material as THREE.Material & { map?: THREE.Texture }).map;
          if (texture) textures.add(texture);
        });
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
      renderer.dispose();
      controls.dispose();
      if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement);
      if (sceneRef.current?.scene === scene) sceneRef.current = null;
    };
  }, [memories, lifeStages, onMemoryClick, params.starSizeBase, params.starSizeIntensity, params.bgStarMultiplier, params.bgOpacity, params.nodeOpacity, params.zThicknessMultiplier]);

  useEffect(() => {
    sceneRef.current?.setDamping(params.dampingFactor);
  }, [params.dampingFactor]);

  // 高亮选中的记忆星星
  useEffect(() => {
    if (!sceneRef.current) return;

    // 遍历所有星系找到对应的 sprite
    sceneRef.current.scene.traverse((obj) => {
      if (obj instanceof THREE.Sprite && obj.userData.type === "memory-star") {
        const memory = obj.userData.memory as MemoryMetadata | undefined;
        if (!memory) return;
        const intensity = previewIntensity?.id === memory.id
          ? previewIntensity.intensity
          : memory.emotion.intensity;
        const baseScale = memoryStarSize(intensity, params.starSizeBase, params.starSizeIntensity);
        obj.userData.baseScale = baseScale;
        const spriteMaterial = obj.material as THREE.SpriteMaterial;
        const isSelected = Boolean(selectedMemory?.id && memory.id === selectedMemory.id);
        spriteMaterial.opacity = isSelected ? 1 : 0.82;
        const scale = baseScale * (isSelected ? 1.4 : 1);
        obj.scale.set(scale, scale, 1);
      }
    });
  }, [selectedMemory, memories, previewIntensity, params.starSizeBase, params.starSizeIntensity]);

  const songResults = songQuery.trim()
    ? memories
      .map((memory) => ({ memory, score: songMatchScore(memory.song, songQuery) }))
      .filter((result): result is { memory: MemoryMetadata; score: number } => result.score !== null)
      .sort((a, b) => b.score - a.score)
      .map(({ memory }) => memory)
    : [];
  const visibleSongResults = songResults.slice(0, SONG_RESULT_LIMIT);
  const songNameCounts = new Map<string, number>();
  visibleSongResults.forEach((memory) => songNameCounts.set(memory.song, (songNameCounts.get(memory.song) ?? 0) + 1));

  const tooltipBounds = containerRef.current?.getBoundingClientRect();
  const tooltipLeft = hoveredMemory && tooltipBounds
    ? Math.max(8, Math.min(hoveredMemory.x + 14, tooltipBounds.width - 190))
    : 0;
  const tooltipTop = hoveredMemory && tooltipBounds
    ? Math.max(8, Math.min(hoveredMemory.y + 14, tooltipBounds.height - 64))
    : 0;

  return (
    <div className="memory-constellation-container">
      <div ref={containerRef} className="memory-constellation-canvas" />
      <div className="memory-constellation-controls">
        <button type="button" className="primary-button memory-constellation-new" onClick={onNewMemory}>
          <Plus size={15} aria-hidden="true" /> 新建记忆
        </button>
        <div className="memory-filter-panel" role="group" aria-label="记忆筛选">
          <div className="memory-song-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={songQuery}
              aria-label="检索歌曲"
              placeholder="检索歌曲 · 支持拼音首字母"
              onChange={(event) => onSongQueryChange(event.target.value)}
            />
            {songQuery && (
              <button
                type="button"
                className="memory-song-search-clear"
                aria-label="清除歌曲检索"
                title="清除歌曲检索"
                onClick={() => onSongQueryChange("")}
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </div>
          {songQuery.trim() && (
            <div className="memory-filter-chips memory-song-results" aria-label="歌曲检索结果">
              {visibleSongResults.length > 0 ? visibleSongResults.map((memory) => {
                const active = selectedMemory?.id === memory.id;
                const detail = [memory.stage, memory.date].filter(Boolean).join(" · ");
                return (
                  <button
                    type="button"
                    key={memory.id}
                    className={`memory-filter-chip memory-song-result ${active ? "active" : ""}`}
                    style={{ "--filter-color": MEMORY_EMOTIONS.find((emotion) => emotion.value === memory.emotion.type)?.color } as CSSProperties}
                    aria-pressed={active}
                    title={`${memory.song || "未命名记忆"} · ${detail}`}
                    onClick={() => {
                      sceneRef.current?.focusMemory(memory.id);
                      void onMemoryClick(memory);
                    }}
                  >
                    <span className="memory-song-result-dot" aria-hidden="true" />
                    {memory.song || "未命名记忆"}
                    {(songNameCounts.get(memory.song) ?? 0) > 1 && <small>{memory.date.slice(0, 4)}</small>}
                  </button>
                );
              }) : <span className="memory-filter-empty">无匹配歌曲</span>}
              {songResults.length > SONG_RESULT_LIMIT && (
                <span className="memory-filter-empty memory-song-results-more">+{songResults.length - SONG_RESULT_LIMIT}</span>
              )}
            </div>
          )}
          <div className="memory-filter-group">
            <div className="memory-filter-heading">
              <span>情绪</span>
              {(songQuery || selectedEmotions.length > 0 || selectedLocations.length > 0) && (
                <button
                  type="button"
                  className="memory-filter-reset"
                  aria-label="重置筛选"
                  title="重置筛选"
                  onClick={onResetFilters}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            <div className="memory-filter-chips">
              {MEMORY_EMOTIONS.map((emotion) => {
                const active = selectedEmotions.includes(emotion.value);
                return (
                  <button
                    type="button"
                    key={emotion.value}
                    className={`memory-filter-chip ${active ? "active" : ""}`}
                    style={{ "--filter-color": emotion.color } as CSSProperties}
                    aria-pressed={active}
                    onClick={() => onToggleEmotion(emotion.value)}
                  >
                    {emotion.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="memory-filter-group">
            <div className="memory-filter-heading"><span>地点</span></div>
            <div className="memory-filter-chips">
              {locations.length > 0 ? locations.map((location) => {
                const active = selectedLocations.includes(location);
                return (
                  <button
                    type="button"
                    key={location}
                    className={`memory-filter-chip ${active ? "active" : ""}`}
                    style={{ "--filter-color": "#6ee7b7" } as CSSProperties}
                    aria-pressed={active}
                    onClick={() => onToggleLocation(location)}
                    title={location}
                  >
                    {location}
                  </button>
                );
              }) : <span className="memory-filter-empty">暂无地点</span>}
            </div>
          </div>
        </div>

        <button
          type="button"
          className={`memory-param-toggle ${paramsOpen ? "active" : ""}`}
          aria-expanded={paramsOpen}
          aria-controls="memory-param-drawer"
          onClick={() => setParamsOpen((open) => !open)}
        >
          <Settings2 size={14} aria-hidden="true" /> 参数
        </button>
        {paramsOpen && (
          <div className="memory-filter-panel memory-param-drawer" id="memory-param-drawer">
            <div className="memory-filter-heading">
              <span>场景参数</span>
              <button
                type="button"
                className="memory-filter-reset"
                aria-label="重置场景参数"
                title="重置场景参数"
                onClick={() => setParams({ ...DEFAULT_PARAMS })}
              >
                <RotateCcw size={14} aria-hidden="true" />
              </button>
            </div>
            {PARAMETER_CONTROLS.map((control) => (
              <label className="memory-param-item" key={control.key}>
                <span className="memory-param-header">
                  <span>{control.label}</span>
                  <strong>{Number(params[control.key].toFixed(2))}</strong>
                </span>
                <input
                  type="range"
                  className="memory-param-slider"
                  min={control.min}
                  max={control.max}
                  step={control.step}
                  value={params[control.key]}
                  aria-label={control.label}
                  onChange={(event) => setParams((current) => ({ ...current, [control.key]: Number(event.target.value) }))}
                />
              </label>
            ))}
          </div>
        )}

        <div className="memory-filter-panel memory-stage-panel">
          <div className="memory-filter-heading">
            <span>阶段</span>
            {activeStage && (
              <button
                type="button"
                className="memory-filter-reset"
                aria-label="返回全景"
                title="返回全景（Escape）"
                onClick={() => sceneRef.current?.returnToGlobal()}
              >
                <RotateCcw size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="memory-stage-nav">
            {lifeStages.map((stage) => (
              <button
                type="button"
                className={`memory-stage-button ${activeStage === stage.name ? "active" : ""}`}
                key={stage.name}
                aria-pressed={activeStage === stage.name}
                onClick={() => sceneRef.current?.zoomToStage(stage.name)}
              >
                <span>{stage.name}</span>
                <span>{stage.start.slice(0, 4)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {hoveredMemory && (
        <div className="memory-star-tooltip" style={{ left: tooltipLeft, top: tooltipTop }} aria-hidden="true">
          <strong>{hoveredMemory.song}</strong>
          <span>{hoveredMemory.date}</span>
        </div>
      )}
      {memories.length === 0 && (
        <div className="memory-constellation-empty" role="status">
          {locations.length === 0 ? "还没有记忆" : "当前筛选下没有记忆"}
        </div>
      )}
      <div className="memory-constellation-hint" aria-label="场景操作说明">
        右键平移 · 左键旋转 · 滚轮缩放<br />点击星云或星点 · Esc 返回
      </div>
    </div>
  );
}

// ========== 辅助函数 ==========
type ExtendedLifeStageForHelper = LifeStage & {
  zStart: number;
  zEnd: number;
};

function dateToZ(dateStr: string, stage: ExtendedLifeStageForHelper): number {
  const stageStart = new Date(stage.start.replace(/\./g, "-") + "-01");
  const stageEnd = new Date(stage.end.replace(/\./g, "-") + "-01");
  const stageDuration = stageEnd.getTime() - stageStart.getTime();

  let targetDate: Date;

  if (dateStr.includes("Q")) {
    const [year, quarter] = dateStr.split("Q");
    const month = (Number.parseInt(quarter) - 1) * 3 + 1;
    targetDate = new Date(`${year}-${month.toString().padStart(2, "0")}-01`);
  } else if (dateStr.length === 8) {
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    targetDate = new Date(`${year}-${month}-${day}`);
  } else {
    return (stage.zStart + stage.zEnd) / 2;
  }

  const dateOffset = targetDate.getTime() - stageStart.getTime();
  const ratio = Math.max(0, Math.min(1, dateOffset / stageDuration));

  return stage.zStart + ratio * (stage.zEnd - stage.zStart);
}

function dateToTimestamp(date: string): number | null {
  const quarter = date.match(/^(\d{4})Q([1-4])$/i);
  if (quarter) return Date.UTC(Number(quarter[1]), (Number(quarter[2]) - 1) * 3, 1);
  const compact = date.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]));
  const timestamp = Date.parse(date);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function stageMonthTimestamp(value: string, endOfMonth = false): number | null {
  const match = value.replace(/\./g, "-").match(/^(\d{4})-(\d{1,2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return endOfMonth ? Date.UTC(year, month, 0, 23, 59, 59, 999) : Date.UTC(year, month - 1, 1);
}

function memoryBelongsToStage(memory: MemoryMetadata, stage: ExtendedLifeStageForHelper): boolean {
  if (memory.stage?.trim()) return memory.stage === stage.name;
  const timestamp = dateToTimestamp(memory.date);
  const start = stageMonthTimestamp(stage.start);
  const end = stageMonthTimestamp(stage.end, true);
  return timestamp !== null && start !== null && end !== null && timestamp >= start && timestamp <= end;
}

const LOCATION_BASE_POSITIONS: Record<string, { x: number; y: number }> = {};

function getLocationBasePosition(location: string): { x: number; y: number } {
  const parts = splitMemoryLocations(location);
  const key = parts.join("|") || location;
  if (!LOCATION_BASE_POSITIONS[key]) {
    const positions = parts.length > 1 ? parts.map((part) => getLocationBasePosition(part)) : [];
    if (positions.length > 0) {
      LOCATION_BASE_POSITIONS[key] = {
        x: positions.reduce((sum, position) => sum + position.x, 0) / positions.length,
        y: positions.reduce((sum, position) => sum + position.y, 0) / positions.length,
      };
      return LOCATION_BASE_POSITIONS[key];
    }
    const hash = key.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const angle = (hash % 360) * (Math.PI / 180);
    const radius = 4 + (hash % 6);
    LOCATION_BASE_POSITIONS[key] = {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  }
  return LOCATION_BASE_POSITIONS[key];
}
