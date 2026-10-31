import { useState } from "react";
import { RefreshCw, Trash2, X } from "lucide-react";
import type { EmotionType, LifeStage, Memory } from "../types";

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

const EMOTION_TYPES: { value: EmotionType; label: string }[] = [
  { value: "nostalgic", label: "怀念" },
  { value: "melancholic", label: "伤感" },
  { value: "excited", label: "兴奋" },
  { value: "calm", label: "平静" },
  { value: "confused", label: "迷茫" },
  { value: "warm", label: "温暖" },
];

function emotionLabel(type: EmotionType): string {
  return EMOTION_TYPES.find((emotion) => emotion.value === type)?.label ?? type;
}

export function MemoryEditor({ memory: initialMemory, lifeStages, onSave, onDelete, onIntensityPreview, onReload, bodyLoading = false, onClose }: MemoryEditorProps) {
  const [memory, setMemory] = useState<Memory>(initialMemory);
  const [attributesOpen, setAttributesOpen] = useState(false);
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

  const summary = `${memory.song || "未命名记忆"} · ${memory.date || "未设日期"} · ${memory.stage || "未设阶段"} · ${memory.location || "未设地点"} · ${emotionLabel(memory.emotion.type)} ${memory.emotion.intensity}`;

  return (
    <div className="memory-editor">
      <header className="memory-editor-header">
        <div><span className="eyebrow">MEMORY CONSTELLATION</span><h3>编辑记忆</h3></div>
        <div className="memory-editor-header-actions">
          <button type="button" className="icon-button" onClick={() => void onReload()} aria-label="重新读取正文" title="重新读取正文" disabled={bodyLoading}><RefreshCw size={16} /></button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭编辑器" title="关闭编辑器"><X size={18} /></button>
        </div>
      </header>

      <div className="memory-editor-content">
        <div className="memory-editor-attributes">
          <button type="button" className="memory-attributes-summary" aria-expanded={attributesOpen} onClick={() => setAttributesOpen((open) => !open)}>
            <span>{summary}</span><span aria-hidden="true">{attributesOpen ? "⌃" : "⌄"}</span>
          </button>
          <div className="memory-attributes-popover" hidden={!attributesOpen}>
              <div className="memory-editor-fields">
                <label className="memory-editor-field memory-editor-field-song"><span>歌曲名</span><input id="memory-song" type="text" value={memory.song} onChange={(event) => updateField("song", event.target.value)} placeholder="例如：南山南" /></label>
                <label className="memory-editor-field"><span>日期</span><input id="memory-date" type="text" value={memory.date} onChange={(event) => updateField("date", event.target.value)} placeholder="2021Q2 或 20220102" /></label>
                <label className="memory-editor-field"><span>阶段</span><select id="memory-stage" value={memory.stage} onChange={(event) => updateField("stage", event.target.value)}><option value="">请选择</option>{lifeStages.map((stage) => <option key={stage.name} value={stage.name}>{stage.name}（{stage.start} - {stage.end}）</option>)}</select></label>
                <label className="memory-editor-field memory-editor-field-location"><span>地点</span><input id="memory-location" type="text" value={memory.location} onChange={(event) => updateField("location", event.target.value)} placeholder="地点可用逗号、斜线或顿号分隔" /></label>
                <label className="memory-editor-field"><span>情绪类型</span><select id="memory-emotion-type" value={memory.emotion.type} onChange={(event) => updateEmotion("type", event.target.value)}>{EMOTION_TYPES.map((emotion) => <option key={emotion.value} value={emotion.value}>{emotion.label}</option>)}</select></label>
                <label className="memory-editor-field memory-editor-intensity"><span>情绪强度 <output>{memory.emotion.intensity}</output></span><input id="memory-emotion-intensity" type="range" min="0" max="10" step="1" value={memory.emotion.intensity} onChange={(event) => updateEmotion("intensity", event.target.value)} aria-label="情绪强度" /></label>
              </div>
          </div>
        </div>

        <div className="memory-editor-body"><div className="memory-editor-body-heading"><label htmlFor="memory-content">记忆正文</label><span>{bodyLoading ? "正在加载正文…" : "可编辑 · 修改后保存"}</span></div><textarea id="memory-content" value={memory.content} onChange={(event) => updateField("content", event.target.value)} placeholder="写下你的回忆……" disabled={bodyLoading} /></div>
        <div className={`memory-editor-status${saveError ? " error" : bodyLoading ? " loading" : ""}`} role="status" aria-live="polite"><span className="memory-editor-status-dot" aria-hidden="true" /><span>{bodyLoading ? "正在加载记忆正文…" : saveError ?? "正文已载入 · 尚未保存"}</span></div>
        <footer className="memory-editor-actions"><button type="button" className={deleteArmed ? "danger-button armed" : "danger-button"} onClick={() => void handleDelete()}><Trash2 size={16} />{deleteArmed ? "再次点击确认删除" : "删除"}</button><div className="button-group"><button type="button" className="secondary-button" onClick={onClose}>关闭</button><button type="button" className="primary-button" onClick={() => void handleSave()} disabled={isSaving}>{isSaving ? "保存中..." : "保存"}</button></div></footer>
      </div>
    </div>
  );
}
