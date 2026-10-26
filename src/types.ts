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

export interface AppSettings {
  schemaVersion: 1;
  periods: PeriodSetting[];
  appearance: AppearanceSettings;
  recall: RecallSettings;
  ai: AiSettings;
}

export interface LoadedAppState {
  board: BoardFile;
  settings: AppSettings;
  abilityForest: AbilityForest;
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

export interface AbilityForest {
  schemaVersion: 1;
  nodes: AbilityNode[];
  mapPositions?: Record<string, { x: number; y: number }>;
  mapState?: AbilityMapState;
}

export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface AiChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: ImageAttachment[];
}

export interface AiProposalPlacement {
  kind: "period" | "hour";
  period?: PeriodId;
  hour?: number;
}

export interface AiProposalItem {
  id: string;
  title: string;
  placement: AiProposalPlacement;
  tags: string;
  reason?: string;
  sourceExcerpt?: string;
  confidence?: "high" | "medium" | "low";
  selected: boolean;
}

export interface AiReply {
  status: "needs_clarification" | "proposal";
  message: string;
  items: Array<Omit<AiProposalItem, "id" | "selected">>;
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
