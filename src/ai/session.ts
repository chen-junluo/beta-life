import type { KnowledgeBundle } from "../recallStorage";
import type { MemorySnapshot } from "../memoryStorage";
import type { AbilityForest, AbilityMapKind, AppSettings, BoardFile, KnowledgeRecord, LifeStage, LoadedAppState, MemoryMetadata } from "../types";
import { loadDiaryMonth, type DiarySnapshot } from "../diaryStorage";
import { AI_TOOLS, applyBoardBatch, applyBoardChange, boardIndex, describeBoardChange } from "./boardTools";
import { applyDiaryChange, commitDiaryChanges, describeDiaryChange, diaryIndex, diaryMonthIndex, findDay, loadDiaryData, monthOfDay, type DiaryData, type DiaryMonths } from "./diaryTools";
import { applyForestChange, describeForestChange, forestIndex, forestMapIndex, readNode, type Forests } from "./forestTools";
import { applyMemoryChange, asMemories, commitMemoryChanges, describeMemoryChange, loadMemoryData, memoryIndex, newMemoryId, readMemory } from "./memoryTools";
import { applyRecallChange, commitRecallChanges, describeRecallChange, dueRecords, loadKnowledge, loadPoints, recallIndex } from "./recallTools";
import { changePanel, type AiChange, type AiPanelId, type AiScope, type AiToolCall, type ChangeKind, type ToolOutcome } from "./types";

/** Everything the assistant may read during one turn, captured when the turn starts. */
export interface AssistantData {
  board: BoardFile;
  settings: AppSettings;
  forests: Forests;
  knowledge: KnowledgeRecord[];
  memories: MemoryMetadata[];
  lifeStages: LifeStage[];
  /** Loaded only when the scope can read the diary. */
  diary: DiaryData | null;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const TOOL_PANELS = new Map(AI_TOOLS.map((tool) => [tool.name, tool]));

function localNow(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${WEEKDAYS[date.getDay()]}`;
}

export function forestsOf(state: LoadedAppState): Forests {
  return { vision: state.abilityForest, research: state.researchAgenda };
}

/** Loads the panels that live on disk (recall, memories, diary) only when the scope can read them. */
export async function loadAssistantData(scope: AiScope, state: LoadedAppState): Promise<AssistantData> {
  const [knowledge, memoryData, diary] = await Promise.all([
    scope.recall ? loadKnowledge() : Promise.resolve([]),
    scope.memories ? loadMemoryData() : Promise.resolve({ memories: [], lifeStages: [] }),
    scope.diary ? loadDiaryData() : Promise.resolve(null),
  ]);
  return { board: state.board, settings: state.settings, forests: forestsOf(state), knowledge, ...memoryData, diary };
}

/** Everything the model sees without calling a tool: the index of each panel the scope can read. */
export function assistantContext(scope: AiScope, data: AssistantData): string {
  return JSON.stringify({
    now: localNow(),
    ...(scope.board && { board: boardIndex(data.board, data.settings) }),
    ...(scope.forest && { forest: forestIndex(data.forests) }),
    ...(scope.recall && { recall: recallIndex(data.knowledge) }),
    ...(scope.memories && { memories: memoryIndex(data.memories, data.lifeStages) }),
    ...(scope.diary && data.diary && { diary: diaryIndex(data.diary) }),
  });
}

const json = (value: unknown) => JSON.stringify(value);

/** Batch reads: one bad id becomes an error entry instead of failing the whole call. */
async function eachId(args: AiToolCall["arguments"], read: (id: string) => unknown): Promise<{ items: unknown[] }> {
  const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
  const items = await Promise.all(ids.map(async (id) => {
    try {
      return await read(id);
    } catch (error) {
      return { id, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return { items };
}
const createdIdFor = (name: string) => (name === "add_memory" ? newMemoryId() : name.startsWith("add_") ? crypto.randomUUID() : undefined);

/**
 * Runs tools for one turn. Reads see the data captured at the start of the turn; writes are
 * checked and staged on per-panel drafts so later calls can build on them, and nothing is saved.
 */
export function createToolSession(data: AssistantData) {
  let board = data.board;
  let forests = data.forests;
  let knowledge = data.knowledge;
  let memories = asMemories(data.memories);
  // Reads see the months as loaded during the turn; staged writes build on `diaryDraft`.
  const diaryLoaded: DiaryMonths = { ...data.diary?.months };
  let diaryDraft: DiaryMonths = { ...diaryLoaded };

  async function ensureMonth(month: string) {
    if (!/^\d{4}$/.test(month)) throw new Error(`month must be YYMM, got "${month}"`);
    diaryLoaded[month] ??= (await loadDiaryMonth(month)).days;
    diaryDraft[month] ??= diaryLoaded[month];
  }

  async function read(call: AiToolCall): Promise<unknown> {
    const args = call.arguments;
    switch (call.name) {
      case "list_boards":
        return { activeBoardId: data.board.activeBoardId, boards: data.board.boards.map((item) => ({ id: item.id, name: item.name, habits: item.items.length })) };
      case "list_habits":
        return boardIndex(data.board, data.settings);
      case "list_nodes": {
        const map = args.map as AbilityMapKind;
        return forestMapIndex(data.forests[map], map);
      }
      case "read_node":
        return eachId(args, (id) => readNode(data.forests, { map: args.map, id }));
      case "list_knowledge":
        return recallIndex(data.knowledge);
      case "read_knowledge":
        return eachId(args, async (id) => {
          const record = data.knowledge.find((item) => item.id === id);
          if (!record) throw new Error(`No knowledge record with id "${id}"`);
          const points = await loadPoints(record.id);
          return { ...record, points: points.map((point) => ({ type: point.type, prompt: point.prompt, reference: point.reference })) };
        });
      case "list_due_reviews":
        return {
          due: await Promise.all(dueRecords(data.knowledge).map(async (record) => ({
            id: record.id,
            title: record.title,
            ...(record.nextReviewAt && { nextReviewAt: record.nextReviewAt }),
            prompts: (await loadPoints(record.id)).map((point) => point.prompt),
          }))),
        };
      case "list_memories":
        return memoryIndex(data.memories, data.lifeStages).memories;
      case "read_memory":
        return eachId(args, (id) => {
          if (!data.memories.some((memory) => memory.id === id)) throw new Error(`No memory with id "${id}"`);
          return readMemory(id);
        });
      case "list_life_stages":
        return memoryIndex([], data.lifeStages).lifeStages;
      case "list_diary": {
        const month = String(args.month);
        await ensureMonth(month);
        return diaryMonthIndex(month, diaryLoaded[month]);
      }
      case "read_diary": {
        const days = Array.isArray(args.days) ? args.days.map(String) : [];
        return {
          items: await Promise.all(days.map(async (id) => {
            try {
              await ensureMonth(monthOfDay(id));
              const day = findDay(diaryLoaded, id);
              return { id, title: day.title, body: day.body };
            } catch (error) {
              return { id, error: error instanceof Error ? error.message : String(error) };
            }
          })),
        };
      }
      default:
        throw new Error(`Unknown tool ${call.name}`);
    }
  }

  function stage(panel: AiPanelId, input: Pick<AiChange, "name" | "arguments" | "createdId">): { kind: ChangeKind; title: string; detail: string } {
    switch (panel) {
      case "board": {
        const display = describeBoardChange(board, input, data.settings);
        board = applyBoardChange(board, input);
        return display;
      }
      case "forest": {
        const display = describeForestChange(forests, input);
        forests = applyForestChange(forests, input);
        return display;
      }
      case "recall": {
        const display = describeRecallChange(knowledge, input);
        knowledge = applyRecallChange(knowledge, input);
        return display;
      }
      case "memories": {
        const display = describeMemoryChange(memories, input);
        memories = applyMemoryChange(memories, input, data.lifeStages);
        return display;
      }
      case "diary": {
        const display = describeDiaryChange(diaryDraft, input);
        diaryDraft = applyDiaryChange(diaryDraft, input);
        return display;
      }
    }
  }

  return {
    async run(call: AiToolCall): Promise<ToolOutcome> {
      const spec = TOOL_PANELS.get(call.name);
      try {
        if (!spec) throw new Error(`Unknown tool ${call.name}`);
        if (spec.access === "read") return { content: json(await read(call)) };
        const input = { name: call.name, arguments: call.arguments, createdId: createdIdFor(call.name) };
        if (spec.panel === "diary") await ensureMonth(monthOfDay(call.arguments.day));
        const display = stage(spec.panel, input);
        const change: AiChange = { id: crypto.randomUUID(), panel: spec.panel, toolCallId: call.id, ...input, ...display, selected: true };
        return {
          content: json({ status: "staged", ...(input.createdId && { id: input.createdId }), note: "Waiting for the user to confirm in the diff card." }),
          change,
        };
      } catch (error) {
        return { content: json({ error: error instanceof Error ? error.message : String(error) }) };
      }
    },
  };
}

type Failure = { changeId: string; reason: string };

export interface CommitTargets {
  getState: () => LoadedAppState | null;
  /** Each call records one undo step in its panel. */
  commitBoard: (board: BoardFile) => void;
  commitForest: (map: AbilityMapKind, forest: AbilityForest) => void;
  recordRecall: (before: KnowledgeBundle[], after: KnowledgeBundle[]) => void;
  recordMemories: (before: MemorySnapshot[], after: MemorySnapshot[]) => void;
  recordDiary: (before: DiarySnapshot[], after: DiarySnapshot[]) => void;
}

/** Writes the confirmed changes panel by panel: one undo step per touched panel (and forest map). */
export async function commitChanges(changes: AiChange[], targets: CommitTargets): Promise<Failure[]> {
  const state = targets.getState();
  if (!state) return changes.map((change) => ({ changeId: change.id, reason: "App state is not loaded" }));
  const of = (panel: AiPanelId) => changes.filter((change) => changePanel(change) === panel);
  const failed: Failure[] = [];

  const boardChanges = of("board");
  if (boardChanges.length > 0) {
    const result = applyBoardBatch(state.board, boardChanges);
    if (result.applied > 0) targets.commitBoard(result.board);
    failed.push(...result.failed);
  }

  const forestChanges = of("forest");
  if (forestChanges.length > 0) {
    const start = forestsOf(state);
    let forests = start;
    for (const change of forestChanges) {
      try {
        forests = applyForestChange(forests, change);
      } catch (error) {
        failed.push({ changeId: change.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    (["vision", "research"] as const).forEach((map) => {
      if (forests[map] !== start[map]) targets.commitForest(map, forests[map]);
    });
  }

  const recallChanges = of("recall");
  if (recallChanges.length > 0) {
    try {
      const result = await commitRecallChanges(recallChanges);
      if (result.after.length > 0) targets.recordRecall(result.before, result.after);
      failed.push(...result.failed);
    } catch (error) {
      failed.push(...recallChanges.map((change) => ({ changeId: change.id, reason: error instanceof Error ? error.message : String(error) })));
    }
  }

  const memoryChanges = of("memories");
  if (memoryChanges.length > 0) {
    try {
      const result = await commitMemoryChanges(memoryChanges);
      if (result.after.length > 0) targets.recordMemories(result.before, result.after);
      failed.push(...result.failed);
    } catch (error) {
      failed.push(...memoryChanges.map((change) => ({ changeId: change.id, reason: error instanceof Error ? error.message : String(error) })));
    }
  }

  const diaryChanges = of("diary");
  if (diaryChanges.length > 0) {
    const result = await commitDiaryChanges(diaryChanges);
    if (result.after.length > 0) targets.recordDiary(result.before, result.after);
    failed.push(...result.failed);
  }
  return failed;
}
