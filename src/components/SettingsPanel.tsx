import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, Database, Flag, Gauge, KeyRound, NotebookPen, Orbit, Palette, PawPrint, Quote, RotateCcw, Settings2, SlidersHorizontal, Sparkles, Target, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { validatePeriodStarts } from "../boardLogic";
import { DEFAULT_ASSISTANT_PROMPT, DEFAULT_DAY_SUMMARY_PROMPT, DEFAULT_DIARY_TEMPLATE, DEFAULT_HABIT_REASONS_PROMPT, DEFAULT_HABIT_SUGGESTION_PROMPT, DEFAULT_EXTRACTION_PROMPT, DEFAULT_KNOWLEDGE_IMPORT_PROMPT, DEFAULT_MEMORY_ANALYSIS_PROMPT, DEFAULT_RECALL_EVALUATION_PROMPT, DEFAULT_RECALL_POINTS_PROMPT } from "../defaults";
import type { ActivityRules } from "../activity";
import { validateLifeStages } from "../memoryLogic";
import { ActivityRulesSettings } from "./ActivityRulesSettings";
import { BebeSettings } from "./BebeSettings";
import { loadPetProfile, quietHoursProblem, savePetProfile, type PetProfile } from "../ai/bebeTools";
import type { AbilityMapKind, AppSettings, BoardFile, LifeStage, PeriodId, TabSlogans } from "../types";

type PromptKey = "assistantPrompt" | "daySummaryPrompt" | "habitReasonsPrompt" | "habitSuggestionPrompt" | "extractionPrompt" | "knowledgeImportPrompt" | "recallPointsPrompt" | "recallEvaluationPrompt" | "memoryAnalysisPrompt";

const PROMPT_FIELDS: Array<{ key: PromptKey; label: string; help: string; fallback: string }> = [
  { key: "assistantPrompt", label: "AI 助手", help: "AI 助手的工作方式和语气。工具协议、@ 权限和「写入前先确认」由应用管理，这里改不掉。", fallback: DEFAULT_ASSISTANT_PROMPT },
  { key: "daySummaryPrompt", label: "日记总结", help: "时间轴页或 bebe 晚间冒泡点「写进日记」后，AI 在统计下面写专注做了什么、对照计划；读时间轴和这天及前 6 天的日记，写入前先确认由应用管理。", fallback: DEFAULT_DAY_SUMMARY_PROMPT },
  { key: "habitReasonsPrompt", label: "阻挠原因", help: "时段结束前 bebe 问「为什么没完成」，AI 按这里的要求把你的回答分到各个习惯卡片的【阻挠习惯的原因】；这一步直接写入，写错了在卡片里改或删。", fallback: DEFAULT_HABIT_REASONS_PROMPT },
  { key: "habitSuggestionPrompt", label: "助推建议", help: "0 点存档后，对 7 天完成率偏低的习惯，bebe 问要不要写建议；AI 读阻挠原因和最近的日记，写在日记【AI总结】下面，写入前先确认由应用管理。", fallback: DEFAULT_HABIT_SUGGESTION_PROMPT },
  { key: "extractionPrompt", label: "习惯提取", help: "点时间板的「AI 提取」后，AI 助手按这里的要求从文字或截图里提取习惯；工具协议和「写入前先确认」由应用管理。", fallback: DEFAULT_EXTRACTION_PROMPT },
  { key: "knowledgeImportPrompt", label: "知识识别与标签推荐", help: "粘贴 Markdown 后，AI 只建议标题、层级标签和来源字段；正文保留原文。", fallback: DEFAULT_KNOWLEDGE_IMPORT_PROMPT },
  { key: "recallPointsPrompt", label: "抽查点起草", help: "根据知识正文生成 framework、mechanism、relationship 抽查点。", fallback: DEFAULT_RECALL_POINTS_PROMPT },
  { key: "recallEvaluationPrompt", label: "抽查评价与反馈", help: "按 FSRS 等级评价关键点，并生成待确认反馈。", fallback: DEFAULT_RECALL_EVALUATION_PROMPT },
  { key: "memoryAnalysisPrompt", label: "记忆分析", help: "从回忆正文中建议歌曲、日期、阶段、地点和情绪；结果仍需检查并手动保存。", fallback: DEFAULT_MEMORY_ANALYSIS_PROMPT },
];

type SettingsSection = "timeline" | "appearance" | "recall" | "stages" | "diary" | "categories" | "bebe" | "goals" | "slogan" | "provider" | "prompt" | "data";

const SLOGAN_FIELDS: Array<{ id: keyof TabSlogans; label: string }> = [
  { id: "board", label: "时间板" },
  { id: "recall", label: "回想" },
  { id: "forest", label: "能力森林" },
  { id: "memories", label: "记忆星云" },
  { id: "diary", label: "日记" },
];

interface SettingsPanelProps {
  settings: AppSettings;
  hasApiKey: boolean;
  onClose: () => void;
  onSave: (settings: AppSettings, apiKey?: string) => Promise<void>;
  onApiKeyCleared: () => void;
  onBoardImported: (board: BoardFile) => void;
  onLifeStagesSaved: () => void;
  /** 能力森林 maps for the 长期目标 page: current name and how many nodes are 在推进. */
  goalMaps: Array<{ kind: AbilityMapKind; name: string; active: number }>;
}

const GOAL_MAP_ORDER: AbilityMapKind[] = ["vision", "research"];

interface SelectOption {
  value: string;
  label: string;
}

function SettingsSelect({
  value,
  options,
  label,
  onChange,
}: {
  value: string;
  options: SelectOption[];
  label: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const triggerBounds = rootRef.current.getBoundingClientRect();
    const scrollBounds = rootRef.current.closest(".settings-content")?.getBoundingClientRect();
    const lowerBoundary = Math.min(window.innerHeight, scrollBounds?.bottom ?? window.innerHeight);
    const spaceBelow = lowerBoundary - triggerBounds.bottom;
    setDropUp(spaceBelow < 238 && triggerBounds.top > spaceBelow);
  }, [open]);

  function moveSelection(direction: 1 | -1) {
    const nextIndex = (selectedIndex + direction + options.length) % options.length;
    onChange(options[nextIndex].value);
    setOpen(true);
  }

  return (
    <div
      className={`settings-select ${open ? "is-open" : ""} ${dropUp ? "opens-up" : ""}`}
      ref={rootRef}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          rootRef.current?.querySelector<HTMLButtonElement>(".settings-select-trigger")?.focus();
        }
      }}
    >
      <button
        type="button"
        className="settings-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveSelection(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            onChange(options[event.key === "Home" ? 0 : options.length - 1].value);
            setOpen(true);
          }
        }}
      >
        <span>{selected?.label}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="settings-select-menu" id={listboxId} role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`settings-select-option ${option.value === value ? "is-selected" : ""}`}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SettingsPanel({
  settings,
  hasApiKey,
  onClose,
  onSave,
  onApiKeyCleared,
  onBoardImported,
  onLifeStagesSaved,
  goalMaps,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<AppSettings>(() => structuredClone(settings));
  const [apiKey, setApiKey] = useState("");
  const [section, setSection] = useState<SettingsSection>("timeline");
  const [promptKey, setPromptKey] = useState<PromptKey>("extractionPrompt");
  const activePrompt = PROMPT_FIELDS.find((field) => field.key === promptKey)!;
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // WKWebView in Tauri does not implement window.confirm, so destructive actions confirm in-app with a second click.
  const [clearKeyArmed, setClearKeyArmed] = useState(false);
  const [importArmed, setImportArmed] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  // Life stages live in their own file, so they load on first visit and save only when edited.
  const [lifeStages, setLifeStages] = useState<LifeStage[] | null>(null);
  const [stagesError, setStagesError] = useState<string | null>(null);
  const savedStages = useRef<string | null>(null);
  // Where the vault lives (Tauri only); changing it moves or adopts the data and restarts the app.
  const [dataFolder, setDataFolder] = useState<{ path: string; isDefault: boolean } | null>(null);
  const [changingFolder, setChangingFolder] = useState(false);
  // Activity categories live in the timeline folder; like life stages they load on first visit.
  const [activityRules, setActivityRules] = useState<ActivityRules | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const savedRules = useRef<string | null>(null);
  // bebe's remembered words live in `bebe/偏好.md`; they load on first visit too.
  const [petProfile, setPetProfile] = useState<PetProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const savedProfile = useRef<string | null>(null);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);

  useEffect(() => {
    if (section !== "data" || dataFolder || !window.__TAURI_INTERNALS__) return;
    invoke<{ path: string; isDefault: boolean } | undefined>("data_folder")
      .then((folder) => setDataFolder(folder ?? null))
      .catch((error) => setStatus(`数据文件夹读取失败：${typeof error === "string" ? error : "未知错误"}`));
  }, [section, dataFolder]);

  useEffect(() => {
    if (section !== "stages" || lifeStages) return;
    invoke<LifeStage[]>("load_life_stages")
      .then((stages) => {
        savedStages.current = JSON.stringify(stages);
        setLifeStages(stages);
      })
      .catch((error) => setStagesError(typeof error === "string" ? error : "阶段读取失败"));
  }, [section, lifeStages]);

  useEffect(() => {
    if (section !== "categories" || activityRules) return;
    invoke<ActivityRules>("load_activity_rules")
      .then((rules) => {
        savedRules.current = JSON.stringify(rules);
        setActivityRules(rules);
      })
      .catch((error) => setRulesError(typeof error === "string" ? error : "分类规则读取失败"));
  }, [section, activityRules]);

  useEffect(() => {
    if (section !== "bebe" || petProfile || !window.__TAURI_INTERNALS__) return;
    loadPetProfile()
      .then((profile) => {
        savedProfile.current = JSON.stringify(profile);
        setPetProfile(profile);
      })
      .catch((error) => setProfileError(typeof error === "string" ? error : "bebe 偏好读取失败"));
  }, [section, petProfile]);

  function updatePeriod(id: PeriodId, patch: Partial<AppSettings["periods"][number]>) {
    setDraft((current) => ({
      ...current,
      periods: current.periods.map((period) => (period.id === id ? { ...period, ...patch } : period)),
    }));
  }

  function updateAi(patch: Partial<AppSettings["ai"]>) {
    setDraft((current) => ({ ...current, ai: { ...current.ai, ...patch } }));
  }

  function updateAppearance(patch: Partial<AppSettings["appearance"]>) {
    setDraft((current) => ({
      ...current,
      appearance: { ...current.appearance, ...patch },
    }));
  }

  function updateRecall(patch: Partial<AppSettings["recall"]>) {
    setDraft((current) => ({
      ...current,
      recall: { ...current.recall, ...patch },
    }));
  }

  /** Tab inserts a tab: diary bullets nest with tabs. */
  function typeTab(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab" || event.shiftKey) return;
    event.preventDefault();
    const field = event.currentTarget;
    const { selectionStart, selectionEnd, value } = field;
    const template = `${value.slice(0, selectionStart)}\t${value.slice(selectionEnd)}`;
    setDraft((current) => ({ ...current, diary: { ...current.diary, template } }));
    requestAnimationFrame(() => field.setSelectionRange(selectionStart + 1, selectionStart + 1));
  }

  function updateSlogan(id: keyof TabSlogans, value: string) {
    setDraft((current) => ({ ...current, slogans: { ...current.slogans, [id]: value } }));
  }

  function updateStage(index: number, patch: Partial<LifeStage>) {
    setLifeStages((current) => current && current.map((stage, stageIndex) => (stageIndex === index ? { ...stage, ...patch } : stage)));
  }

  async function save() {
    const stagesChanged = lifeStages !== null && JSON.stringify(lifeStages) !== savedStages.current;
    const quietError = draft.pet.quietHours.map(quietHoursProblem).find(Boolean) ?? null;
    const validationError = validatePeriodStarts(draft) ?? quietError ?? (stagesChanged ? validateLifeStages(lifeStages) : null);
    if (validationError) {
      setStatus(validationError);
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await onSave(draft, apiKey.trim() || undefined);
      if (stagesChanged) {
        await invoke("save_life_stages", { stages: lifeStages });
        savedStages.current = JSON.stringify(lifeStages);
        onLifeStagesSaved();
      }
      if (activityRules !== null && JSON.stringify(activityRules) !== savedRules.current) {
        const saved = await invoke<ActivityRules>("save_activity_rules", { rules: activityRules });
        savedRules.current = JSON.stringify(saved);
        setActivityRules(saved);
      }
      if (petProfile !== null && JSON.stringify(petProfile) !== savedProfile.current) {
        const saved = await savePetProfile(petProfile);
        savedProfile.current = JSON.stringify(saved);
        setPetProfile(saved);
      }
      setApiKey("");
      setStatus("设置已保存");
    } catch (error) {
      setStatus(typeof error === "string" ? error : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function clearApiKey() {
    if (!clearKeyArmed) { setClearKeyArmed(true); return; }
    setClearKeyArmed(false);
    try {
      await invoke("delete_api_key");
      onApiKeyCleared();
      setStatus("API key 已清除");
    } catch (error) {
      setStatus(typeof error === "string" ? error : "清除失败");
    }
  }

  /** Rust shows the folder picker and the confirmation; on success the app restarts. */
  async function changeDataFolder() {
    setChangingFolder(true);
    try {
      await invoke("change_data_folder");
    } catch (error) {
      setStatus(`更改数据文件夹失败：${typeof error === "string" ? error : "未知错误"}`);
    } finally {
      setChangingFolder(false);
    }
  }

  async function exportBoard() {
    try {
      const result = await invoke<string | null>("export_board");
      if (result) setStatus(`已导出到 ${result}`);
    } catch (error) {
      setStatus(typeof error === "string" ? error : "导出失败");
    }
  }

  function openImportPicker() {
    if (!importArmed) {
      setImportArmed(true);
      setStatus("导入会替换当前时间板，建议先导出备份。再次点击选择文件。");
      return;
    }
    setImportArmed(false);
    importInput.current?.click();
  }

  async function importBoard(file: File | undefined) {
    if (!file) return;
    try {
      const jsonContents = await file.text();
      const board = await invoke<BoardFile>("import_board", { jsonContents });
      onBoardImported(board);
      setStatus("时间板已导入");
    } catch (error) {
      setStatus(typeof error === "string" ? error : "导入失败");
    }
  }

  const navItems: Array<{ id: SettingsSection; label: string; icon: React.ReactNode }> = [
    { id: "timeline", label: "时间与颜色", icon: <Palette size={17} /> },
    { id: "appearance", label: "布局与字号", icon: <SlidersHorizontal size={17} /> },
    { id: "recall", label: "回想与记忆", icon: <Target size={17} /> },
    { id: "stages", label: "记忆阶段", icon: <Orbit size={17} /> },
    { id: "diary", label: "日记", icon: <NotebookPen size={17} /> },
    { id: "categories", label: "分类", icon: <Gauge size={17} /> },
    { id: "bebe", label: "bebe", icon: <PawPrint size={17} /> },
    { id: "goals", label: "长期目标", icon: <Flag size={17} /> },
    { id: "slogan", label: "Slogan", icon: <Quote size={17} /> },
    { id: "provider", label: "AI Provider", icon: <KeyRound size={17} /> },
    { id: "prompt", label: "AI Prompt", icon: <Sparkles size={17} /> },
    { id: "data", label: "数据", icon: <Database size={17} /> },
  ];
  const hourOptions: SelectOption[] = Array.from({ length: 24 }, (_, hour) => ({
    value: String(hour),
    label: `${String(hour).padStart(2, "0")}:00`,
  }));
  const providerOptions: SelectOption[] = [
    { value: "deepseek", label: "DeepSeek" },
    { value: "custom", label: "Custom / OpenAI-compatible" },
  ];

  return (
    <div className="sheet-backdrop settings-backdrop" onMouseDown={onClose}>
      <section
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-panel-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sheet-header settings-header">
          <div>
            <span className="eyebrow">PREFERENCES</span>
            <h2 id="settings-panel-title">Settings</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav">
            {navItems.map((item) => (
              <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}>
                {item.icon} {item.label}
              </button>
            ))}
          </nav>

          <main className="settings-content">
            {section === "timeline" && (
              <div className="settings-section timeline-settings">
                <div className="section-heading">
                  <Settings2 size={21} />
                  <div><h3>时间分界</h3><p>每个时段从选定的整点开始；睡眠可以自然跨过午夜。</p></div>
                </div>
                <div className="period-settings-grid">
                  {draft.periods.map((period) => (
                    <div className="period-setting-row" key={period.id}>
                      <input
                        type="color"
                        value={period.color}
                        onChange={(event) => updatePeriod(period.id, { color: event.target.value })}
                        aria-label={`${period.label}颜色`}
                      />
                      <label>
                        <span>名称</span>
                        <input value={period.label} onChange={(event) => updatePeriod(period.id, { label: event.target.value })} />
                      </label>
                      <label>
                        <span>开始时间</span>
                        <SettingsSelect
                          value={String(period.startHour)}
                          options={hourOptions}
                          label={`${period.label}开始时间`}
                          onChange={(value) => updatePeriod(period.id, { startHour: Number(value) })}
                        />
                      </label>
                    </div>
                  ))}
                </div>
                <div className="settings-note">时间板始终从“早上”的开始时间显示，并按一天的循环顺序排列。</div>
              </div>
            )}

            {section === "appearance" && (
              <div className="settings-section">
                <div className="section-heading">
                  <SlidersHorizontal size={21} />
                  <div><h3>布局与字号</h3><p>分别调整时间板背景文字、slogan、习惯内容与 tags 的字号。</p></div>
                </div>
                <div className="range-setting">
                  <div className="range-setting-header">
                    <strong>卡片最小宽度</strong>
                    <output>{draft.appearance.cardMinWidth}px</output>
                  </div>
                  <input
                    type="range"
                    min="100"
                    max="240"
                    step="4"
                    value={draft.appearance.cardMinWidth}
                    onChange={(event) => updateAppearance({ cardMinWidth: Number(event.target.value) })}
                  />
                  <p>卡片会优先横向排列；空间不足时自动换到下一行。</p>
                </div>
                <div className="font-size-settings-grid">
                  <div className="range-setting">
                    <div className="range-setting-header">
                      <strong>时间与背景文字</strong>
                      <output>{draft.appearance.backgroundFontSize}px</output>
                    </div>
                    <input
                      type="range"
                      min="8"
                      max="18"
                      step="1"
                      value={draft.appearance.backgroundFontSize}
                      onChange={(event) => updateAppearance({ backgroundFontSize: Number(event.target.value) })}
                    />
                    <p>包括具体 XX:00、时段范围、分区名称与添加提示。</p>
                  </div>
                  <div className="range-setting">
                    <div className="range-setting-header">
                      <strong>Slogan</strong>
                      <output>{draft.appearance.sloganFontSize}px</output>
                    </div>
                    <input
                      type="range"
                      min="9"
                      max="24"
                      step="1"
                      value={draft.appearance.sloganFontSize}
                      onChange={(event) => updateAppearance({ sloganFontSize: Number(event.target.value) })}
                    />
                    <p>控制每个时段 slogan 的显示与编辑字号。</p>
                  </div>
                  <div className="range-setting">
                    <div className="range-setting-header">
                      <strong>习惯内容</strong>
                      <output>{draft.appearance.habitFontSize}px</output>
                    </div>
                    <input
                      type="range"
                      min="9"
                      max="24"
                      step="1"
                      value={draft.appearance.habitFontSize}
                      onChange={(event) => updateAppearance({ habitFontSize: Number(event.target.value) })}
                    />
                    <p>控制时间板上每张习惯卡片的正文字号。</p>
                  </div>
                  <div className="range-setting">
                    <div className="range-setting-header">
                      <strong>Tags</strong>
                      <output>{draft.appearance.tagFontSize}px</output>
                    </div>
                    <input
                      type="range"
                      min="7"
                      max="18"
                      step="1"
                      value={draft.appearance.tagFontSize}
                      onChange={(event) => updateAppearance({ tagFontSize: Number(event.target.value) })}
                    />
                    <p>控制习惯卡片中标签的字号。</p>
                  </div>
                </div>
                <div className="range-setting">
                  <div className="range-setting-header">
                    <strong>整个界面缩放</strong>
                    <output>{draft.appearance.zoomPercent}%</output>
                  </div>
                  <input
                    type="range"
                    min="50"
                    max="150"
                    step="5"
                    value={draft.appearance.zoomPercent}
                    onChange={(event) => updateAppearance({ zoomPercent: Number(event.target.value) })}
                  />
                  <p>也可以随时使用 Option/Alt + 加号或减号缩放；Option/Alt + 0 恢复 100%。</p>
                </div>
                <div className="settings-note">各项字号只影响时间板；“整个界面缩放”仍会统一缩放全部界面。</div>
              </div>
            )}

            {section === "provider" && (
              <div className="settings-section form-grid provider-settings">
                <div className="section-heading">
                  <KeyRound size={21} />
                  <div><h3>AI Provider</h3><p>请求由本地 Rust 后端发送；密钥单独保存在系统安全存储。</p></div>
                </div>
                <label className="settings-field-card">
                  <span>Provider</span>
                  <SettingsSelect
                    value={draft.ai.provider}
                    options={providerOptions}
                    label="AI Provider"
                    onChange={(value) => {
                      const provider = value as "deepseek" | "custom";
                      updateAi(
                        provider === "deepseek"
                          ? { provider, baseUrl: "https://api.deepseek.com", model: "deepseek-chat", supportsImages: false, useJsonMode: true }
                          : { provider },
                      );
                    }}
                  />
                </label>
                <label className="settings-field-card">
                  <span>Base URL</span>
                  <input value={draft.ai.baseUrl} onChange={(event) => updateAi({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
                </label>
                <label className="settings-field-card">
                  <span>Model</span>
                  <input value={draft.ai.model} onChange={(event) => updateAi({ model: event.target.value })} />
                </label>
                <label className="settings-field-card">
                  <span>API key {hasApiKey && <em>已安全保存</em>}</span>
                  <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={hasApiKey ? "留空表示不修改" : "输入 API key"} autoComplete="off" />
                </label>
                <div className="two-column-fields">
                  <label className="settings-field-card">
                    <span>Temperature</span>
                    <input type="number" min="0" max="2" step="0.1" value={draft.ai.temperature} onChange={(event) => updateAi({ temperature: Number(event.target.value) })} />
                  </label>
                  <label className="settings-field-card">
                    <span>Max tokens</span>
                    <input type="number" min="512" max="32768" step="256" value={draft.ai.maxTokens} onChange={(event) => updateAi({ maxTokens: Number(event.target.value) })} />
                  </label>
                </div>
                <label className="toggle-row">
                  <input type="checkbox" checked={draft.ai.useJsonMode} onChange={(event) => updateAi({ useJsonMode: event.target.checked })} />
                  <span><strong>使用 JSON mode</strong><small>DeepSeek 默认开启；部分兼容接口可能不支持。</small></span>
                </label>
                <label className="toggle-row">
                  <input type="checkbox" checked={draft.ai.supportsImages} onChange={(event) => updateAi({ supportsImages: event.target.checked })} />
                  <span><strong>此模型接受图片</strong><small>只有确认当前模型支持 OpenAI-compatible 图片消息时才开启。</small></span>
                </label>
                {hasApiKey && <button className={clearKeyArmed ? "danger-button align-start armed" : "danger-button align-start"} onClick={() => void clearApiKey()}>{clearKeyArmed ? "再次点击确认清除 API key" : "清除已保存的 API key"}</button>}
              </div>
            )}

            {section === "recall" && (
              <div className="settings-section">
                <div className="section-heading">
                  <Target size={21} />
                  <div><h3>回想与记忆</h3><p>目标记忆率决定 FSRS 何时把知识点视为需要抽查，并同步显示在记忆曲线中。</p></div>
                </div>
                <div className="range-setting">
                  <div className="range-setting-header">
                    <strong>目标触发线 R</strong>
                    <output>{Math.round(draft.recall.desiredRetention * 100)}%</output>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="0.99"
                    step="0.01"
                    value={draft.recall.desiredRetention}
                    onChange={(event) => updateRecall({ desiredRetention: Number(event.target.value) })}
                    aria-label="目标触发线 R"
                  />
                  <p>当前 R 达到或低于此值的知识点会进入优先抽查池；修改后会按新目标重建 FSRS 调度。</p>
                </div>
                <div className="settings-note">这条线表示模型的目标保留率，不是对真实脑内记忆率的直接测量。</div>
              </div>
            )}

            {section === "stages" && (
              <div className="settings-section">
                <div className="section-heading">
                  <Orbit size={21} />
                  <div><h3>记忆阶段</h3><p>记忆星云按这些时间范围排列阶段星系；没有手动选择阶段的记忆按日期自动归入。</p></div>
                </div>
                {lifeStages ? (
                  <div className="period-settings-grid">
                    {lifeStages.map((stage, index) => (
                      <div className="period-setting-row stage-setting-row" key={index}>
                        <strong className="stage-setting-name" title={stage.name}>
                          <i style={{ background: stage.color }} aria-hidden="true" />
                          <span>{stage.name}</span>
                        </strong>
                        <label>
                          <span>开始月份</span>
                          <input value={stage.start} placeholder="YYYY-MM" onChange={(event) => updateStage(index, { start: event.target.value.trim() })} aria-label={`${stage.name}开始月份`} />
                        </label>
                        <label>
                          <span>结束月份</span>
                          <input value={stage.end} placeholder="YYYY-MM" onChange={(event) => updateStage(index, { end: event.target.value.trim() })} aria-label={`${stage.name}结束月份`} />
                        </label>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="settings-note">{stagesError ?? "正在读取阶段…"}</div>
                )}
                <div className="settings-note">格式为 YYYY-MM，结束月份包含在阶段内。阶段名称被已有记忆引用，这里只调整时间范围。</div>
              </div>
            )}

            {section === "diary" && (
              <div className="settings-section form-grid diary-settings">
                <div className="section-heading">
                  <NotebookPen size={21} />
                  <div><h3>日记</h3><p>每月一个 md（例如 <code>日记/2611 diary.md</code>）；每天以 <code>## 261111周三</code> 开头，下面的正文可以是任意格式；天与天之间用 <code>---</code> 分隔。</p></div>
                </div>
                <label className="prompt-field-card">
                  <span>新一天的模板</span>
                  <small>点「写今天」时预填在日期标题下面的正文；可以用 <code>{"{{date}}"}</code> 代表 <code>261111周三</code>。Tab 键输入缩进，嵌套 bullet 用 Tab 缩进。最后一行 <code>==…【AI总结】==…</code> 是分隔线：上面是你写的，时间轴「写进日记」、0 点的习惯统计和助推建议都写在它下面；这一天没有分隔线时会自动补上。</small>
                  <textarea className="diary-template" rows={6} value={draft.diary.template} onChange={(event) => setDraft((current) => ({ ...current, diary: { ...current.diary, template: event.target.value } }))} onKeyDown={typeTab} spellCheck={false} />
                  <button className="secondary-button align-start" type="button" onClick={() => setDraft((current) => ({ ...current, diary: { ...current.diary, template: DEFAULT_DIARY_TEMPLATE } }))}><RotateCcw size={15} /> 恢复默认</button>
                </label>
              </div>
            )}

            {section === "categories" && (
              <div className="settings-section form-grid categories-settings">
                <div className="section-heading">
                  <Gauge size={21} />
                  <div><h3>分类</h3><p>时间轴里的每段时间算专注、中性还是摸鱼；bebe 按这些规则判断要不要提醒。没有规则的算「待分类」，不计入摸鱼。</p></div>
                </div>
                <div className="activity-ai-settings">
                  <label className="settings-field-card">
                    <span>AI 能读最近多少天</span>
                    <input type="number" min="1" max="3650" step="1" value={draft.activity.aiDays} onChange={(event) => setDraft((current) => ({ ...current, activity: { ...current.activity, aiDays: Math.min(3650, Math.max(1, Math.round(Number(event.target.value)) || 1)) } }))} />
                  </label>
                  <label className="toggle-row">
                    <input type="checkbox" checked={draft.activity.aiTitles} onChange={(event) => setDraft((current) => ({ ...current, activity: { ...current.activity, aiTitles: event.target.checked } }))} />
                    <span><strong>AI 能看到窗口标题</strong><small>对话里 @时间轴 时生效。关掉后 AI 只看到应用、网站、分类和时长；时间轴页面照常显示标题。</small></span>
                  </label>
                </div>
                {activityRules ? <ActivityRulesSettings rules={activityRules} onChange={setActivityRules} /> : <div className="settings-note">{rulesError ?? "正在读取分类规则…"}</div>}
              </div>
            )}

            {section === "bebe" && (
              <div className="settings-section form-grid bebe-settings">
                <div className="section-heading">
                  <PawPrint size={21} />
                  <div><h3>bebe</h3><p>bebe 什么时候提醒、什么时候安静，以及你让它记住的话。在对话里说一句也能改：「今晚别提醒我」这类临时的马上生效、可以撤销；「以后都……」这类长期的会先出确认卡。</p></div>
                </div>
                <BebeSettings pet={draft.pet} onPetChange={(pet) => setDraft((current) => ({ ...current, pet }))} profile={petProfile} profileError={profileError} onProfileChange={setPetProfile} />
              </div>
            )}

            {section === "goals" && (
              <div className="settings-section form-grid goal-settings">
                <div className="section-heading">
                  <Flag size={21} />
                  <div><h3>长期目标</h3><p>能力森林里标为「在推进」的中 / 小节点，会在晚间「写进日记」时对照当天日记：AI 把推进了什么写在【AI总结】的「长期目标」下面，能力森林里显示最近一次推进和时间线。</p></div>
                </div>
                <div className="goal-map-list">
                  <span className="goal-map-label">对哪些地图生效</span>
                  {goalMaps.map((map) => (
                    <label className="toggle-row" key={map.kind}>
                      <input
                        type="checkbox"
                        checked={draft.goals.maps.includes(map.kind)}
                        onChange={(event) => setDraft((current) => ({
                          ...current,
                          goals: { maps: GOAL_MAP_ORDER.filter((kind) => kind === map.kind ? event.target.checked : current.goals.maps.includes(kind)) },
                        }))}
                      />
                      <span><strong>{map.name}</strong><small>{map.active > 0 ? `${map.active} 个在推进` : "还没有在推进的节点"}</small></span>
                    </label>
                  ))}
                </div>
                <div className="settings-note">没勾选的地图里不显示「在推进」，晚间总结也不读它；已标的节点会保留，重新勾选后恢复。</div>
              </div>
            )}

            {section === "slogan" && (
              <div className="settings-section form-grid slogan-settings">
                <div className="section-heading">
                  <Quote size={21} />
                  <div><h3>Slogan</h3><p>每个面板顶栏显示的一句话；也可以直接点击顶栏里的 slogan 编辑。</p></div>
                </div>
                {SLOGAN_FIELDS.map((field) => (
                  <label className="settings-field-card" key={field.id}>
                    <span>{field.label}</span>
                    <input
                      value={draft.slogans[field.id]}
                      onChange={(event) => updateSlogan(field.id, event.target.value)}
                      placeholder="点击添加这个面板的 slogan"
                      aria-label={`${field.label} slogan`}
                    />
                  </label>
                ))}
                <div className="settings-note">留空时顶栏只显示占位提示；时间板各时段列里的 slogan 在时间板上单独编辑。</div>
              </div>
            )}

            {section === "prompt" && (
              <div className="settings-section form-grid prompt-settings">
                <div className="section-heading">
                  <Sparkles size={21} />
                  <div><h3>AI Prompt</h3><p>统一管理 AI 辅助任务的语言和风格。JSON 协议与安全规则由应用管理，不会被这里覆盖。</p></div>
                </div>
                <div className="prompt-nav" role="tablist" aria-label="选择 Prompt">
                  {PROMPT_FIELDS.map((field) => (
                    <button key={field.key} type="button" role="tab" aria-selected={promptKey === field.key} className={promptKey === field.key ? "active" : ""} onClick={() => setPromptKey(field.key)} title={field.label}>
                      <span>{field.label}</span>
                    </button>
                  ))}
                </div>
                <label className="prompt-field-card" role="tabpanel"><span>{activePrompt.label}</span><small>{activePrompt.help}</small><textarea rows={14} value={draft.ai[activePrompt.key]} onChange={(event) => updateAi({ [activePrompt.key]: event.target.value })} /><button className="secondary-button align-start" type="button" onClick={() => updateAi({ [activePrompt.key]: activePrompt.fallback })}><RotateCcw size={15} /> 恢复默认</button></label>
              </div>
            )}

            {section === "data" && (
              <div className="settings-section">
                <div className="section-heading">
                  <Database size={21} />
                  <div><h3>数据管理</h3><p>数据文件夹里的 md 可以直接用 Obsidian 打开；导出只包含时间板内容，不包含 API key、Provider 或 Prompt。</p></div>
                </div>
                {dataFolder && (
                  <div className="data-folder">
                    <strong>数据文件夹{dataFolder.isDefault ? "（默认位置）" : ""}</strong>
                    <div className="data-folder-row">
                      <code title={dataFolder.path}>{dataFolder.path}</code>
                      <button className="secondary-button" onClick={() => void changeDataFolder()} disabled={changingFolder}>
                        {changingFolder ? "正在选择…" : "更改…"}
                      </button>
                    </div>
                    <p>所有 tab 的 md、.beta-life 里的机器数据和设置都在这里，可以整体交给坚果云同步；窗口位置和 API key 留在本机。选空文件夹会把数据移过去，选已有的 beta-life 数据文件夹会直接改用里面的数据，之后 beta-life 自动重启。</p>
                  </div>
                )}
                <div className="data-actions">
                  <button className="secondary-button" onClick={() => void exportBoard()}>导出 Board JSON</button>
                  <input
                    ref={importInput}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(event) => void importBoard(event.target.files?.[0])}
                  />
                  <button className="secondary-button" onClick={openImportPicker}>{importArmed ? "再次点击选择文件" : "导入 Board JSON"}</button>
                </div>
                <div className="settings-note">所有修改都保存在上面的数据文件夹。导入前建议先导出一份备份。</div>
              </div>
            )}
          </main>
        </div>

        <footer className="settings-footer">
          <span className={status?.includes("失败") || status?.includes("不能") ? "status-error" : ""}>{status}</span>
          <button className="primary-button" onClick={() => void save()} disabled={saving}>
            <Check size={17} /> {saving ? "保存中…" : "保存设置"}
          </button>
        </footer>
      </section>
    </div>
  );
}
