import type { AppSettings, BoardFile, PeriodId } from "./types";

export const DEFAULT_EXTRACTION_PROMPT = `请从用户提供的文字、对话或图片内容中提取真正可执行、适合作为长期生活安排的习惯。

要求：
1. 忽略冗长背景、营销内容和无法执行的泛泛建议。
2. 每个 item 只表达一个动作，标题简洁自然。
3. 不要为了显得精确而虚构时间。只知道早中晚时使用 period；原文明确到小时或有充分理由时才使用 hour。
4. 保留简短、来源忠实的 tags、理由和原文依据，不能把推测写成原文事实。
5. 信息不足且会显著影响安排时，先提出一个简短澄清问题。`;

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  periods: [
    { id: "morning", label: "早上", startHour: 7, color: "#F59E0B", slogan: "" },
    { id: "noon", label: "中午", startHour: 12, color: "#10B981", slogan: "" },
    { id: "evening", label: "晚上", startHour: 18, color: "#6366F1", slogan: "" },
    { id: "sleep", label: "睡眠", startHour: 23, color: "#64748B", slogan: "" },
  ],
  appearance: {
    cardMinWidth: 140,
    zoomPercent: 80,
    backgroundFontSize: 10,
    sloganFontSize: 11,
    habitFontSize: 11,
    tagFontSize: 8,
  },
  ai: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    temperature: 0.2,
    maxTokens: 4096,
    supportsImages: false,
    useJsonMode: true,
    extractionPrompt: DEFAULT_EXTRACTION_PROMPT,
  },
};

export const DEFAULT_BOARD: BoardFile = {
  schemaVersion: 1,
  activeBoardId: "default",
  boards: [{ id: "default", name: "My Life", items: [] }],
};

export const PERIOD_IDS: PeriodId[] = ["morning", "noon", "evening", "sleep"];
