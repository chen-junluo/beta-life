import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, Database, KeyRound, Palette, RotateCcw, Settings2, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { validatePeriodStarts } from "../boardLogic";
import { DEFAULT_EXTRACTION_PROMPT, DEFAULT_KNOWLEDGE_IMPORT_PROMPT, DEFAULT_RECALL_EVALUATION_PROMPT, DEFAULT_RECALL_POINTS_PROMPT } from "../defaults";
import type { AppSettings, BoardFile, PeriodId } from "../types";

type SettingsSection = "timeline" | "appearance" | "provider" | "prompt" | "data";

interface SettingsPanelProps {
  settings: AppSettings;
  hasApiKey: boolean;
  onClose: () => void;
  onSave: (settings: AppSettings, apiKey?: string) => Promise<void>;
  onApiKeyCleared: () => void;
  onBoardImported: (board: BoardFile) => void;
}

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
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<AppSettings>(() => structuredClone(settings));
  const [apiKey, setApiKey] = useState("");
  const [section, setSection] = useState<SettingsSection>("timeline");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);

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

  async function save() {
    const validationError = validatePeriodStarts(draft);
    if (validationError) {
      setStatus(validationError);
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await onSave(draft, apiKey.trim() || undefined);
      setApiKey("");
      setStatus("设置已保存");
    } catch (error) {
      setStatus(typeof error === "string" ? error : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function clearApiKey() {
    if (!window.confirm("确定从系统安全存储中清除当前 API key 吗？")) return;
    try {
      await invoke("delete_api_key");
      onApiKeyCleared();
      setStatus("API key 已清除");
    } catch (error) {
      setStatus(typeof error === "string" ? error : "清除失败");
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

  async function importBoard(file: File | undefined) {
    if (!file) return;
    if (!window.confirm("导入会替换当前时间板。建议先导出备份，是否继续？")) return;
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
                {hasApiKey && <button className="danger-button align-start" onClick={() => void clearApiKey()}>清除已保存的 API key</button>}
              </div>
            )}

            {section === "prompt" && (
              <div className="settings-section form-grid prompt-settings">
                <div className="section-heading">
                  <Sparkles size={21} />
                  <div><h3>AI Prompt</h3><p>统一管理四类 AI 辅助任务的语言和风格。JSON 协议与安全规则由应用管理，不会被这里覆盖。</p></div>
                </div>
                <label className="prompt-field-card"><span>习惯提取</span><small>从文字、对话或图片中提取时间板习惯。</small><textarea rows={9} value={draft.ai.extractionPrompt} onChange={(event) => updateAi({ extractionPrompt: event.target.value })} /><button className="secondary-button align-start" type="button" onClick={() => updateAi({ extractionPrompt: DEFAULT_EXTRACTION_PROMPT })}><RotateCcw size={15} /> 恢复默认</button></label>
                <label className="prompt-field-card"><span>知识识别与标签推荐</span><small>粘贴 Markdown 后，AI 只建议标题、层级标签和来源字段；正文保留原文。</small><textarea rows={9} value={draft.ai.knowledgeImportPrompt} onChange={(event) => updateAi({ knowledgeImportPrompt: event.target.value })} /><button className="secondary-button align-start" type="button" onClick={() => updateAi({ knowledgeImportPrompt: DEFAULT_KNOWLEDGE_IMPORT_PROMPT })}><RotateCcw size={15} /> 恢复默认</button></label>
                <label className="prompt-field-card"><span>抽查点起草</span><small>根据知识正文生成 framework、mechanism、relationship 抽查点。</small><textarea rows={9} value={draft.ai.recallPointsPrompt} onChange={(event) => updateAi({ recallPointsPrompt: event.target.value })} /><button className="secondary-button align-start" type="button" onClick={() => updateAi({ recallPointsPrompt: DEFAULT_RECALL_POINTS_PROMPT })}><RotateCcw size={15} /> 恢复默认</button></label>
                <label className="prompt-field-card"><span>抽查评价与反馈</span><small>评价关键点覆盖、事实正确性和机制/关系，并生成待确认反馈。</small><textarea rows={9} value={draft.ai.recallEvaluationPrompt} onChange={(event) => updateAi({ recallEvaluationPrompt: event.target.value })} /><button className="secondary-button align-start" type="button" onClick={() => updateAi({ recallEvaluationPrompt: DEFAULT_RECALL_EVALUATION_PROMPT })}><RotateCcw size={15} /> 恢复默认</button></label>
              </div>
            )}

            {section === "data" && (
              <div className="settings-section">
                <div className="section-heading">
                  <Database size={21} />
                  <div><h3>数据管理</h3><p>导出只包含时间板内容，不包含 API key、Provider 或 Prompt。</p></div>
                </div>
                <div className="data-actions">
                  <button className="secondary-button" onClick={() => void exportBoard()}>导出 Board JSON</button>
                  <input
                    ref={importInput}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(event) => void importBoard(event.target.files?.[0])}
                  />
                  <button className="secondary-button" onClick={() => importInput.current?.click()}>导入 Board JSON</button>
                </div>
                <div className="settings-note">所有修改都保存在系统应用数据目录。导入前建议先导出一份备份。</div>
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
