export type AiPanelId = "board" | "recall" | "forest" | "memories";
/** "write" includes "read". A panel missing from the scope is not accessible. */
export type AiAccess = "read" | "write";
export type AiScope = Partial<Record<AiPanelId, AiAccess>>;

export interface AiToolSpec {
  name: string;
  panel: AiPanelId;
  access: AiAccess;
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
  panel: AiPanelId;
  status: AiBatchStatus;
  changes: AiChange[];
  failed?: Array<{ changeId: string; reason: string }>;
}

export type ConversationMessage =
  | { id: string; role: "user"; content: string; scope: AiScope; createdAt: string }
  | { id: string; role: "assistant"; content: string; toolCalls: CheckedToolCall[]; createdAt: string }
  | { id: string; role: "tool"; toolCallId: string; name: string; content: string; createdAt: string }
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
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: AiToolCall[] }
  | { role: "tool"; content: string; toolCallId: string }
  | { role: "note"; content: string };

export interface ToolOutcome {
  /** JSON string returned to the model as the tool result. */
  content: string;
  change?: AiChange;
}
