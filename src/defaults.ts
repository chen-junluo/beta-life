import type { AppSettings, BoardFile, PeriodId } from "./types";

export const DEFAULT_EXTRACTION_PROMPT = `请从用户提供的文字、对话或图片内容中提取真正可执行、适合作为长期生活安排的习惯。

要求：
1. 忽略冗长背景、营销内容和无法执行的泛泛建议。
2. 每个 item 只表达一个动作，标题简洁自然。
3. 不要为了显得精确而虚构时间。只知道早中晚时使用 period；原文明确到小时或有充分理由时才使用 hour。
4. 保留简短、来源忠实的 tags、理由和原文依据，不能把推测写成原文事实。
5. 信息不足且会显著影响安排时，先提出一个简短澄清问题。`;

export const DEFAULT_KNOWLEDGE_IMPORT_PROMPT = `你负责把用户粘贴的 Markdown 知识整理成可复习的知识条目。

要求：
1. 保留用户原文中的事实，不要补写原文没有支持的内容；标题要简洁、准确。
2. 推荐用 / 分隔的层级标签，优先使用原文明确出现的学科、主题和概念。
3. 如果输入内容本身是中文，使用中文输出字段；如果主要是英文，使用英文输出字段；混合内容按输入的主要语言回答，并保留必要的专业术语原文。
4. 没有可靠来源链接或来源备注时返回空字符串，不要猜测。
5. 只返回字段建议，Markdown 正文由应用保留为用户粘贴的原文。`;

export const DEFAULT_RECALL_POINTS_PROMPT = `你负责根据知识 Markdown 起草抽查点。

要求：
1. 只使用 Markdown 中明确支持的事实，抽查点覆盖框架、机制或关系，避免重复。
2. 如果输入主要是中文，用中文提出问题和参考要点；如果主要是英文，用英文；混合内容按输入主要语言回答，并保留必要的专业术语。
3. 每个抽查点都要短、可回答，参考要点只写核对所需的核心内容。
4. 不要生成 pointId，应用会分配稳定 ID。`;

export const DEFAULT_RECALL_EVALUATION_PROMPT = `你负责评价用户对知识抽查点的回答。

评价原则：
1. 以 Markdown 为事实来源，参考要点是评分依据，不是唯一正确措辞。认可含义一致的同义表达、转述、顺序变化，以及分散在答案不同位置的内容。
2. 先整体阅读答案，再逐点评价。不要因为用户把一个概念放在错误的分类或框架下，就把答案中明确出现的其他正确概念也判为没答到。复合抽查点只答对一部分时，保留答对的部分，并具体指出需要纠正之处。
3. 不要要求逐字复现或擅自提高参考要点之外的要求。回忆出全部核心概念、关系或特征时，即使回答简短，也应视为充分。
4. 选择最符合实际回忆质量的 FSRS 等级：Again 表示核心内容基本未回忆出或关键事实根本性错误；Hard 表示回忆有明显困难、只答出部分内容，或核心方向对但仍有重要缺口；Good 表示核心内容正确且覆盖充分；Easy 仅用于内容准确完整、并且用户明确表示回忆轻松的情况。不要仅因少一个次要细节就判 Again。
5. 反馈简短、具体、可行动；指出具体答对、答错或缺失的内容。能从答案准确摘录时才填写 evidence，否则留空。不要做字面相似度百分比。
6. 根据输入内容的主要语言回复；混合语言按回答和知识的主要语言动态选择，保留必要的专业术语。`;

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
  recall: {
    desiredRetention: 0.9,
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
    knowledgeImportPrompt: DEFAULT_KNOWLEDGE_IMPORT_PROMPT,
    recallPointsPrompt: DEFAULT_RECALL_POINTS_PROMPT,
    recallEvaluationPrompt: DEFAULT_RECALL_EVALUATION_PROMPT,
  },
};

export const DEFAULT_BOARD: BoardFile = {
  schemaVersion: 1,
  activeBoardId: "default",
  boards: [{ id: "default", name: "My Life", items: [] }],
};

export const PERIOD_IDS: PeriodId[] = ["morning", "noon", "evening", "sleep"];
