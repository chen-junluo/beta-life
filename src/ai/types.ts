import type { PlanUndo } from "../pet/plan";

/** `timeline` (the activity record) is read only. */
export type AiPanelId = "board" | "recall" | "forest" | "memories" | "diary" | "timeline";
/** The access a panel gets when a conversation starts from it: the timeline can only be read. */
export const defaultAccess = (panel: AiPanelId): AiAccess => (panel === "timeline" ? "read" : "write");
/** "write" includes "read". A panel missing from the scope is not accessible. */
export type AiAccess = "read" | "write";
export type AiScope = Partial<Record<AiPanelId, AiAccess>>;

/** Where a tool belongs: a panel, or bebe's own tools, which every conversation has. */
export type AiToolPanel = AiPanelId | "bebe";

export interface AiToolSpec {
  name: string;
  panel: AiToolPanel;
  access: AiAccess;
  /** instant: applied at once with an undo (bebe's plan); choices: buttons that end the turn. */
  effect?: "instant" | "choices";
  description: string;
  inputSchema: unknown;
}

export type ToolArguments = Record<string, unknown>;

export interface AiToolCall {
  id: string;
  name: string;
  arguments: ToolArguments;
}

/** A tool call after Rust checked its name, scope and arguments. */
export interface CheckedToolCall extends AiToolCall {
  error?: string;
}

export interface ChatStepReply {
  content: string;
  toolCalls: CheckedToolCall[];
}

export type ChangeKind = "add" | "edit" | "move" | "del";

/** One staged write. It is replayed against the live data when the user confirms. */
export interface AiChange {
  id: string;
  /** Missing on changes saved by P2.1, which were all board changes. */
  panel?: AiToolPanel;
  toolCallId: string;
  name: string;
  arguments: ToolArguments;
  /** Id assigned to a habit created by add_habit, so later changes and the model can refer to it. */
  createdId?: string;
  kind: ChangeKind;
  title: string;
  detail: string;
  selected: boolean;
}

/** superseded: the user sent a new message instead of confirming. */
export type AiBatchStatus = "pending" | "confirmed" | "cancelled" | "superseded";

export interface AiBatch {
  id: string;
  status: AiBatchStatus;
  changes: AiChange[];
  failed?: Array<{ changeId: string; reason: string }>;
}

/** Entry action that pre-fills a new conversation: a chip in the composer, the prompt lives in `AppSettings.ai`. */
export type AiTask = "extract_habits" | "summarize_day" | "suggest_habits";
/** Tasks whose append_diary goes under the day's 【AI总结】 line. */
export const SUMMARY_TASKS: AiTask[] = ["summarize_day", "suggest_habits"];
export const AI_TASKS: Record<AiTask, { label: string; panel: AiPanelId }> = {
  extract_habits: { label: "提取习惯", panel: "board" },
  summarize_day: { label: "写日记总结", panel: "diary" },
  suggest_habits: { label: "助推建议", panel: "diary" },
};

/** An image pasted or dropped into the composer: `dataUrl` reaches the model in this turn only. */
export interface AiImageDraft {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  /** Small JPEG kept in the conversation. */
  thumbnail: string;
}

export type StoredImage = Pick<AiImageDraft, "id" | "name" | "thumbnail">;

export type ConversationMessage =
  | { id: string; role: "user"; content: string; scope: AiScope; images?: StoredImage[]; task?: AiTask; createdAt: string }
  | { id: string; role: "assistant"; content: string; toolCalls: CheckedToolCall[]; createdAt: string }
  | { id: string; role: "tool"; toolCallId: string; name: string; content: string; action?: InstantAction; choices?: string[]; createdAt: string }
  | { id: string; role: "batch"; batch: AiBatch; createdAt: string };

export interface Conversation {
  id: string;
  title: string;
  /** Panel the conversation was started from. */
  panel: AiPanelId;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  panel: AiPanelId;
  createdAt: string;
  updatedAt: string;
}

/** Message shape sent to the Rust `ai_chat_step` command. */
export type WireMessage =
  | { role: "user"; content: string; task?: AiTask; images?: Array<{ mimeType: string; dataUrl: string }> }
  | { role: "assistant"; content: string; toolCalls: AiToolCall[] }
  | { role: "tool"; content: string; toolCallId: string }
  | { role: "note"; content: string };

export const changePanel = (change: AiChange): AiToolPanel => change.panel ?? "board";

/** A bebe action that already happened (no diff card); the user can undo it from the chat. */
export interface InstantAction {
  label: string;
  undo: PlanUndo;
  undone?: boolean;
}

export interface ToolOutcome {
  /** JSON string returned to the model as the tool result. */
  content: string;
  change?: AiChange;
  action?: InstantAction;
  /** offer_choices: buttons under the reply; the turn ends. */
  choices?: string[];
}
