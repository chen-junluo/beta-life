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
}

export interface AppearanceSettings {
  cardMinWidth: number;
  zoomPercent: number;
  backgroundFontSize: number;
  sloganFontSize: number;
  habitFontSize: number;
  tagFontSize: number;
}

export interface AppSettings {
  schemaVersion: 1;
  periods: PeriodSetting[];
  appearance: AppearanceSettings;
  ai: AiSettings;
}

export interface LoadedAppState {
  board: BoardFile;
  settings: AppSettings;
  hasApiKey: boolean;
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
