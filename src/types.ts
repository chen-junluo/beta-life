import type { FSRSParameters } from "ts-fsrs";

export type PeriodId = "morning" | "noon" | "evening" | "sleep";

export type BoardViewMode = "global" | PeriodId;

export type Placement =
  | { kind: "period"; period: PeriodId }
  | { kind: "hour"; hour: number };

export interface Habit {
  id: string;
  title: string;
  description: string;
  tags: string;
  placement: Placement;
  order: number;
  sourceExcerpt?: string;
  createdAt: string;
  updatedAt: string;
  /** Daily to-do check; cleared by the board's "reset today" action. */
  done?: boolean;
}

export interface Board {
  id: string;
  name: string;
  items: Habit[];
}

export interface BoardFile {
  schemaVersion: 1;
  activeBoardId: string;
  boards: Board[];
}

export interface PeriodSetting {
  id: PeriodId;
  label: string;
  startHour: number;
  color: string;
  slogan: string;
}

export type AiProvider = "deepseek" | "custom";

export interface AiSettings {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  supportsImages: boolean;
  useJsonMode: boolean;
  extractionPrompt: string;
  knowledgeImportPrompt: string;
  recallPointsPrompt: string;
  recallEvaluationPrompt: string;
  memoryAnalysisPrompt: string;
  assistantPrompt: string;
  /** 写进日记: what the AI writes about the day's focus work. */
  daySummaryPrompt: string;
}

export interface AppearanceSettings {
  cardMinWidth: number;
  zoomPercent: number;
  backgroundFontSize: number;
  sloganFontSize: number;
  habitFontSize: number;
  tagFontSize: number;
}

export interface RecallSettings {
  desiredRetention: number;
}

export interface TabSlogans {
  board: string;
  recall: string;
  forest: string;
  memories: string;
  diary: string;
}

/** What the AI may read of the activity record. */
export interface ActivitySettings {
  /** The last this many days, today included. */
  aiDays: number;
  /** Off: apps, sites, categories and durations only. */
  aiTitles: boolean;
}

export interface DiarySettings {
  /** The body of a new day under its `## YYMMDD周X` heading; `{{date}}` becomes `YYMMDD周X`. */
  template: string;
}

/** One day of a month file: `id` is `YYMMDD`, `YYMMDD-2` for a repeated date, or `preamble`. */
export interface DiaryDay {
  id: string;
  date: string | null;
  /** The `## ` heading without its marks, e.g. `261111周三`. */
  title: string;
  /** Everything under the heading. */
  body: string;
}

export interface DiaryMonth {
  /** `YYMM`. */
  month: string;
  days: DiaryDay[];
}

export type DiarySaveOutcome =
  | { status: "saved"; id: string | null; month: DiaryMonth }
  /** The day's body changed on disk since it was read; `current` is null when the day is gone. */
  | { status: "conflict"; current: string | null };

export interface AppSettings {
  schemaVersion: 1;
  periods: PeriodSetting[];
  appearance: AppearanceSettings;
  recall: RecallSettings;
  ai: AiSettings;
  slogans: TabSlogans;
  /** Tag name -> emoji shown before the tag; "" means no icon (show #). */
  tagIcons: Record<string, string>;
  diary: DiarySettings;
  activity: ActivitySettings;
}

export interface LoadedAppState {
  board: BoardFile;
  settings: AppSettings;
  abilityForest: AbilityForest;
  researchAgenda: AbilityForest;
  hasApiKey: boolean;
}

export interface AbilityNode {
  id: string;
  name: string;
  level: number;
  parentId: string | null;
  order: number;
  color: string | null;
  markdown: string;
}

export interface AbilityMapState {
  seed: number;
  zoom: number;
  pan: { x: number; y: number };
  visibleLevels: number;
  options: {
    baseRadius: number;
    clusterSpread: number;
    largeNodeRadius: number;
    mediumNodeRadius: number;
  };
  selectedId: string | null;
  mapWidth?: number;
  treeHeight?: number;
}

/** The ability tab holds two independent maps: the long-term vision and the short-term research agenda. */
export type AbilityMapKind = "vision" | "research";

export interface AbilityForest {
  schemaVersion: 1;
  /** Sheet-tab name shown under the map; falls back to the default name for its kind. */
  name?: string;
  nodes: AbilityNode[];
  mapPositions?: Record<string, { x: number; y: number }>;
  mapState?: AbilityMapState;
}

export type ContainerId = `period:${PeriodId}` | `hour:${number}`;

export type RecallPointType = "framework" | "mechanism" | "relationship";
export type FsrsGrade = "Again" | "Hard" | "Good" | "Easy";
export type RecallStatus = FsrsGrade;
export type LegacyRecallStatus = "wrong" | "omitted" | "incomplete" | "misunderstood" | "correct";
export type RecallMode = "framework" | "point" | "full";
export type RecallSource = "manual" | "ai";

export interface KnowledgeRecord {
  id: string;
  title: string;
  markdown: string;
  tags: string;
  sourceUrl?: string;
  sourceNote?: string;
  createdAt: string;
  updatedAt: string;
  nextReviewAt?: string;
}

export interface RecallPoint {
  pointId: string;
  knowledgeId: string;
  type: RecallPointType;
  prompt: string;
  reference: string;
  order: number;
}

export interface ReviewItem {
  pointId?: string;
  status: RecallStatus;
  evidence?: string;
  feedback: string;
  accepted?: boolean;
}

export interface ReviewRecord {
  reviewId: string;
  knowledgeId: string;
  pointId?: string;
  mode: RecallMode;
  answer: string;
  status: RecallStatus | LegacyRecallStatus;
  feedback: string;
  evidence: string;
  confirmedAt: string;
  nextReviewAt: string;
  source: RecallSource;
  selectionReason?: string;
  grade?: FsrsGrade;
  algorithm?: string;
  fsrsVersion?: string;
  parameters?: FSRSParameters;
}

export interface FsrsCardSnapshot {
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  lastRetrievability: number;
  state: "New" | "Learning" | "Review" | "Relearning";
  lastReview?: string;
}

export interface FsrsSchedulerSnapshot {
  schemaVersion: 1;
  knowledgeId: string;
  algorithm: "ts-fsrs";
  fsrsVersion: string;
  parameters: FSRSParameters;
  desiredRetention: number;
  cards: Record<string, FsrsCardSnapshot>;
  updatedAt: string;
  migration?: {
    complete: boolean;
    migratedAt: string;
    warning?: string;
  };
}

export interface RecallEvaluationDraft {
  items: ReviewItem[];
  nextReviewAt: string;
  message?: string;
}

// Memory Constellation Types
export type EmotionType = "nostalgic" | "melancholic" | "excited" | "calm" | "confused" | "warm";

export interface Emotion {
  type: EmotionType;
  intensity: number; // 0-10
}

export interface Memory {
  id: string;
  song: string;
  date: string; // 支持 "2021Q2", "20220102", "高考完暑假" 等
  stage: string;
  location: string;
  emotion: Emotion;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryMetadata {
  id: string;
  song: string;
  date: string;
  stage?: string;
  location: string;
  emotion: Emotion;
  createdAt: string;
  updatedAt: string;
}

export interface LifeStage {
  name: string;
  start: string; // YYYY-MM
  end: string;   // YYYY-MM
  color?: string;
}

/** An md file in the data folder that could not be read; Rust skips it and leaves it untouched. */
export interface VaultIssue {
  panel: string;
  path: string;
  message: string;
}
