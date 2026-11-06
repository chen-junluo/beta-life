import { useState } from "react";
import { RefreshCw, Trash2, X } from "lucide-react";
import type { EmotionType, LifeStage, Memory } from "../types";
import { MarkdownEditor } from "./MarkdownEditor";
import { MemoryFieldChips } from "./MemoryFields";

interface MemoryEditorProps {
  memory: Memory;
  lifeStages: LifeStage[];
  onSave: (memory: Memory) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onIntensityPreview?: (id: string, intensity: number) => void;
  onReload: () => void | Promise<void>;
  bodyLoading?: boolean;
  onClose: () => void;
}

export function MemoryEditor({ memory: initialMemory, lifeStages, onSave, onDelete, onIntensityPreview, onReload, bodyLoading = false, onClose }: MemoryEditorProps) {
  const [memory, setMemory] = useState<Memory>(initialMemory);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);

  function updateField<K extends keyof Memory>(field: K, value: Memory[K]) {
    setMemory((prev) => ({ ...prev, [field]: value }));
  }

  function updateEmotion(field: "type" | "intensity", value: string | number) {
    if (field === "type") {
      setMemory((prev) => ({ ...prev, emotion: { ...prev.emotion, type: value as EmotionType } }));
      return;
    }
    const intensity = Number(value);
    setMemory((prev) => ({ ...prev, emotion: { ...prev.emotion, intensity } }));
    onIntensityPreview?.(memory.id, intensity);
  }

  async function handleSave() {
    setIsSaving(true);
    setSaveError(null);
    try {
      await onSave({ ...memory, stage: memory.stage.trim() });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    // WKWebView in Tauri does not implement window.confirm, so confirm in-app with a second click.
    if (!deleteArmed) { setDeleteArmed(true); return; }
    setSaveError(null);
    try {
      await onDelete(memory.id);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="memory-editor">
      <header className="memory-editor-header">
        <div className="title-header-main">
          <span className="eyebrow">MEMORY · 编辑</span>
          <input id="memory-song" className="sheet-title-input" value={memory.song} onChange={(event) => updateField("song", event.target.value)} placeholder="歌曲名，例如：南山南" aria-label="歌曲名" />
        </div>
        <div className="title-header-actions">
          <button type="button" className="icon-button" onClick={() => void onReload()} aria-label="重新读取正文" title="重新读取正文" disabled={bodyLoading}><RefreshCw size={16} /></button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭编辑器" title="关闭编辑器"><X size={18} /></button>
        </div>
      </header>

      <div className="memory-editor-content">
        <div className="chip-row">
          <MemoryFieldChips memory={memory} lifeStages={lifeStages} idPrefix="memory" onField={updateField} onEmotion={updateEmotion} />
        </div>
        <MarkdownEditor id="memory-content" className="memory-editor-text" value={memory.content} onChange={(value) => updateField("content", value)} placeholder="写下你的回忆……" disabled={bodyLoading} aria-label="记忆正文" />
        <footer className="memory-editor-actions">
          <button type="button" className={deleteArmed ? "danger-button armed" : "danger-button"} onClick={() => void handleDelete()}><Trash2 size={16} />{deleteArmed ? "再次点击确认删除" : "删除"}</button>
          <div className={`memory-editor-status${saveError ? " error" : bodyLoading ? " loading" : ""}`} role="status" aria-live="polite"><span className="memory-editor-status-dot" aria-hidden="true" /><span>{bodyLoading ? "正在加载记忆正文…" : saveError ?? "正文已载入 · 修改后保存"}</span></div>
          <div className="button-group"><button type="button" className="secondary-button" onClick={onClose}>关闭</button><button type="button" className="primary-button" onClick={() => void handleSave()} disabled={isSaving}>{isSaving ? "保存中..." : "保存"}</button></div>
        </footer>
      </div>
    </div>
  );
}
