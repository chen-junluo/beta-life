import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Save, Sparkles, X } from "lucide-react";
import type { EmotionType, LifeStage, Memory } from "../types";

interface MemoryCreateSheetProps {
  initialMemory: Memory;
  lifeStages: LifeStage[];
  hasApiKey: boolean;
  onSave: (memory: Memory) => Promise<void>;
  onClose: () => void;
  onOpenSettings: () => void;
}

type IntakeMode = "manual" | "ai";

const EMOTION_TYPES: { value: EmotionType; label: string }[] = [
  { value: "nostalgic", label: "怀念" },
  { value: "melancholic", label: "伤感" },
  { value: "excited", label: "兴奋" },
  { value: "calm", label: "平静" },
  { value: "confused", label: "迷茫" },
  { value: "warm", label: "温暖" },
];

const EMOTION_VALUES = new Set<EmotionType>(EMOTION_TYPES.map(({ value }) => value));

export function MemoryCreateSheet({
  initialMemory,
  lifeStages,
  hasApiKey,
  onSave,
  onClose,
  onOpenSettings,
}: MemoryCreateSheetProps) {
  const [memory, setMemory] = useState(initialMemory);
  const [intakeMode, setIntakeMode] = useState<IntakeMode>("manual");
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function update<K extends keyof Memory>(field: K, value: Memory[K]) {
    setMemory((current) => ({ ...current, [field]: value }));
  }

  function updateEmotion(field: "type" | "intensity", value: string | number) {
    setMemory((current) => ({
      ...current,
      emotion: {
        ...current.emotion,
        [field]: field === "intensity" ? Number(value) : value as EmotionType,
      },
    }));
  }

  async function analyzeMemory() {
    if (!memory.content.trim()) {
      setError("请先粘贴或输入记忆正文。");
      return;
    }
    if (!hasApiKey) {
      onOpenSettings();
      return;
    }

    setParsing(true);
    setError(null);
    try {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const analyzed = await invoke<{
        song: string | null;
        date: string | null;
        stage: string | null;
        location: string | null;
        emotion: { type: EmotionType | null; intensity: number | null } | null;
        content: string;
      }>("parse_memory_with_ai", { text: memory.content, today });

      setMemory((current) => ({
        ...current,
        song: analyzed.song ?? current.song,
        date: analyzed.date ?? current.date,
        stage: analyzed.stage ?? current.stage,
        location: analyzed.location ?? current.location,
        emotion: {
          type: analyzed.emotion?.type && EMOTION_VALUES.has(analyzed.emotion.type)
            ? analyzed.emotion.type
            : current.emotion.type,
          intensity: analyzed.emotion?.intensity ?? current.emotion.intensity,
        },
      }));
      setIntakeMode("manual");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setParsing(false);
    }
  }

  async function saveMemory() {
    if (!memory.content.trim()) {
      setError("记忆正文不能为空。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const id = `memory_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      await onSave({ ...memory, id, stage: memory.stage.trim() });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="sheet-backdrop memory-create-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="side-sheet memory-create-sheet" role="dialog" aria-modal="true" aria-labelledby="memory-create-title">
        <header className="sheet-header">
          <div>
            <span className="eyebrow">MEMORY CONSTELLATION</span>
            <h2 id="memory-create-title">新建记忆</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭新建记忆">
            <X size={18} />
          </button>
        </header>

        <div className="sheet-form memory-create-form">
          <div className="recall-intake-switch memory-intake-switch" role="tablist" aria-label="记忆录入方式">
            <button
              type="button"
              role="tab"
              aria-selected={intakeMode === "manual"}
              className={intakeMode === "manual" ? "active" : ""}
              onClick={() => { setIntakeMode("manual"); setError(null); }}
            >
              手动录入
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={intakeMode === "ai"}
              className={intakeMode === "ai" ? "active" : ""}
              onClick={() => { setIntakeMode("ai"); setError(null); }}
            >
              粘贴回忆 · AI 识别
            </button>
          </div>

          {intakeMode === "ai" && (
            <section className="recall-import-panel memory-ai-panel">
              <div className="recall-import-heading">
                <div>
                  <span>回忆正文</span>
                  <small>AI 会参考今天的日期、阶段划分和全部已有记忆来推断字段；结果只填入下方表单，检查、修改后再保存。</small>
                </div>
                <Sparkles size={17} aria-hidden="true" />
              </div>
              <textarea
                value={memory.content}
                onChange={(event) => update("content", event.target.value)}
                placeholder="写下发生了什么、当时在哪里，以及与哪首歌有关……"
                aria-label="用于 AI 识别的记忆正文"
              />
              <div className="recall-import-actions">
                <button className="primary-button" type="button" onClick={() => void analyzeMemory()} disabled={parsing}>
                  <Sparkles size={15} aria-hidden="true" />
                  {parsing ? "识别中…" : "AI 识别并填入"}
                </button>
                {!hasApiKey && <button className="text-button" type="button" onClick={onOpenSettings}>配置 Provider</button>}
              </div>
            </section>
          )}

          <div className="two-column-fields memory-create-fields">
            <label>
              <span>歌曲名</span>
              <input id="memory-create-song" value={memory.song} onChange={(event) => update("song", event.target.value)} placeholder="例如：南山南" />
            </label>
            <label>
              <span>日期</span>
              <input id="memory-create-date" value={memory.date} onChange={(event) => update("date", event.target.value)} placeholder="2021Q2 或 20220102" />
            </label>
            <label>
              <span>阶段</span>
              <select id="memory-create-stage" value={memory.stage} onChange={(event) => update("stage", event.target.value)}>
                <option value="">请选择</option>
                {lifeStages.map((stage) => <option key={stage.name} value={stage.name}>{stage.name}（{stage.start} - {stage.end}）</option>)}
              </select>
            </label>
            <label>
              <span>地点</span>
              <input id="memory-create-location" value={memory.location} onChange={(event) => update("location", event.target.value)} placeholder="校园、城市或旅行地" />
            </label>
            <label>
              <span>情绪类型</span>
              <select id="memory-create-emotion" value={memory.emotion.type} onChange={(event) => updateEmotion("type", event.target.value)}>
                {EMOTION_TYPES.map((emotion) => <option key={emotion.value} value={emotion.value}>{emotion.label}</option>)}
              </select>
            </label>
            <label className="memory-create-intensity">
              <span>情绪强度 <output>{memory.emotion.intensity}</output></span>
              <input
                type="range"
                min="0"
                max="10"
                step="1"
                value={memory.emotion.intensity}
                onChange={(event) => updateEmotion("intensity", event.target.value)}
                aria-label="情绪强度"
              />
            </label>
          </div>

          {intakeMode === "manual" && (
            <label className="memory-create-content-field">
              <span>记忆正文</span>
              <textarea value={memory.content} onChange={(event) => update("content", event.target.value)} placeholder="写下这段记忆……" />
            </label>
          )}

          {error && <div className="inline-error memory-create-error" role="alert">{error}</div>}
        </div>

        <footer className="settings-footer memory-create-footer">
          <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>取消</button>
          <button className="primary-button" type="button" onClick={() => void saveMemory()} disabled={saving || parsing}>
            <Save size={15} aria-hidden="true" /> {saving ? "保存中…" : "保存记忆"}
          </button>
        </footer>
      </section>
    </div>
  );
}
