import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Save, Sparkles, X } from "lucide-react";
import type { EmotionType, LifeStage, Memory } from "../types";
import { MarkdownEditor } from "./MarkdownEditor";
import { EMOTION_TYPES, MemoryFieldChips } from "./MemoryFields";

interface MemoryCreateSheetProps {
  initialMemory: Memory;
  lifeStages: LifeStage[];
  hasApiKey: boolean;
  onSave: (memory: Memory) => Promise<void>;
  onClose: () => void;
  onOpenSettings: () => void;
}

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
      <section className="side-sheet memory-create-sheet" role="dialog" aria-modal="true" aria-label="新建记忆">
        <header className="sheet-header title-header">
          <div className="title-header-main">
            <span className="eyebrow">MEMORY · 新建</span>
            <input id="memory-create-song" className="sheet-title-input" value={memory.song} onChange={(event) => update("song", event.target.value)} placeholder="歌曲名，例如：南山南" aria-label="歌曲名" />
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭新建记忆">
            <X size={18} />
          </button>
        </header>

        <div className="sheet-form memory-create-form title-sheet-body">
          <div className="chip-row">
            <MemoryFieldChips memory={memory} lifeStages={lifeStages} idPrefix="memory-create" onField={update} onEmotion={updateEmotion} />
          </div>
          <MarkdownEditor
            className="sheet-main-editor"
            autoFocus
            value={memory.content}
            onChange={(value) => update("content", value)}
            placeholder={"写下发生了什么、当时在哪里，以及与哪首歌有关……\n也可以先粘贴一段回忆，再点「AI 识别并填入」补全上面的字段。"}
            aria-label="记忆正文"
          />
          {error && <div className="inline-error memory-create-error" role="alert">{error}</div>}
        </div>

        <footer className="settings-footer memory-create-footer">
          <button
            className="secondary-button footer-start"
            type="button"
            onClick={() => void analyzeMemory()}
            disabled={parsing}
            title="AI 会参考今天的日期、阶段划分和全部已有记忆来推断字段；结果只填入表单，检查、修改后再保存。"
          >
            <Sparkles size={15} aria-hidden="true" />
            {parsing ? "识别中…" : hasApiKey ? "AI 识别并填入" : "配置 Provider 后用 AI 识别"}
          </button>
          <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>取消</button>
          <button className="primary-button" type="button" onClick={() => void saveMemory()} disabled={saving || parsing}>
            <Save size={15} aria-hidden="true" /> {saving ? "保存中…" : "保存记忆"}
          </button>
        </footer>
      </section>
    </div>
  );
}
