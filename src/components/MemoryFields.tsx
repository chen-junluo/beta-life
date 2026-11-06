import { CalendarDays, Check, Heart, MapPin, Milestone, Plus } from "lucide-react";
import type { EmotionType, LifeStage, Memory } from "../types";
import { ChipPopover, ChipTextInput } from "./ChipFields";

export const EMOTION_TYPES: { value: EmotionType; label: string }[] = [
  { value: "nostalgic", label: "怀念" },
  { value: "melancholic", label: "伤感" },
  { value: "excited", label: "兴奋" },
  { value: "calm", label: "平静" },
  { value: "confused", label: "迷茫" },
  { value: "warm", label: "温暖" },
];

export function emotionLabel(type: EmotionType): string {
  return EMOTION_TYPES.find((emotion) => emotion.value === type)?.label ?? type;
}

type MemoryTextField = "date" | "stage" | "location";

/** Date, stage, location and emotion as chips; empty values show as dashed "+ 字段" chips. */
export function MemoryFieldChips({ memory, lifeStages, idPrefix, onField, onEmotion }: {
  memory: Memory;
  lifeStages: LifeStage[];
  /** Prefix for input ids, e.g. `memory` → `#memory-date`, `#memory-emotion-intensity`. */
  idPrefix: string;
  onField: (field: MemoryTextField, value: string) => void;
  onEmotion: (field: "type" | "intensity", value: string | number) => void;
}) {
  const icon = (value: string, Icon: typeof CalendarDays) =>
    value ? <Icon size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />;
  const emotion = `${emotionLabel(memory.emotion.type)} · ${memory.emotion.intensity}`;

  return (
    <>
      <ChipPopover label={memory.date || "日期"} tone={memory.date ? "default" : "ghost"} icon={icon(memory.date, CalendarDays)} ariaLabel={`日期：${memory.date || "未设置"}`} popoverLabel="日期">
        {(close) => <ChipTextInput id={`${idPrefix}-date`} label="日期" value={memory.date} onChange={(value) => onField("date", value)} close={close} placeholder="2021Q2 或 20220102" />}
      </ChipPopover>
      <ChipPopover label={memory.stage || "阶段"} tone={memory.stage ? "default" : "ghost"} icon={icon(memory.stage, Milestone)} ariaLabel={`阶段：${memory.stage || "未设置"}`} popoverLabel="阶段">
        {(close) => (
          <div className="chip-options" role="listbox" aria-label="阶段">
            {[{ name: "", start: "", end: "" }, ...lifeStages].map((stage) => (
              <button
                type="button"
                role="option"
                key={stage.name || "none"}
                aria-selected={memory.stage === stage.name}
                className={`settings-select-option ${memory.stage === stage.name ? "is-selected" : ""}`}
                onClick={() => { onField("stage", stage.name); close(); }}
              >
                <span>{stage.name || "不设置"}</span>
                {stage.name && <small>{stage.start} – {stage.end}</small>}
              </button>
            ))}
          </div>
        )}
      </ChipPopover>
      <ChipPopover label={memory.location || "地点"} tone={memory.location ? "default" : "ghost"} icon={icon(memory.location, MapPin)} ariaLabel={`地点：${memory.location || "未设置"}`} popoverLabel="地点">
        {(close) => <ChipTextInput id={`${idPrefix}-location`} label="地点" value={memory.location} onChange={(value) => onField("location", value)} close={close} placeholder="地点可用逗号、斜线或顿号分隔" />}
      </ChipPopover>
      <ChipPopover label={emotion} icon={<Heart size={13} aria-hidden="true" />} ariaLabel={`情绪：${emotion}`} popoverLabel="情绪">
        {() => (
          <>
            <div className="emotion-options" role="radiogroup" aria-label="情绪类型">
              {EMOTION_TYPES.map((item) => (
                <button
                  type="button"
                  role="radio"
                  key={item.value}
                  aria-checked={memory.emotion.type === item.value}
                  className={memory.emotion.type === item.value ? "is-selected" : ""}
                  onClick={() => onEmotion("type", item.value)}
                >
                  {memory.emotion.type === item.value && <Check size={12} aria-hidden="true" />}
                  {item.label}
                </button>
              ))}
            </div>
            <label className="chip-text-field emotion-intensity">
              <span>情绪强度 <output>{memory.emotion.intensity}</output></span>
              <input
                id={`${idPrefix}-emotion-intensity`}
                type="range"
                min="0"
                max="10"
                step="1"
                value={memory.emotion.intensity}
                onChange={(event) => onEmotion("intensity", event.target.value)}
                aria-label="情绪强度"
              />
            </label>
          </>
        )}
      </ChipPopover>
    </>
  );
}
