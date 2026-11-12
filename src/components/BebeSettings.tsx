import { Plus, X } from "lucide-react";
import { useState } from "react";
import { PET_NUMBER_FIELDS, PROFILE_SECTIONS, type PetProfile, type ProfileSection } from "../ai/bebeTools";
import { WEEKDAYS } from "../pet/reminders";
import type { PetSettings, QuietHours, Weekday } from "../types";

type BebeTab = "reminders" | "quiet" | ProfileSection;

const NEW_QUIET: QuietHours = { days: ["mon", "tue", "wed", "thu", "fri"], start: "14:00", end: "16:00" };

/** Settings → bebe: the numbers live in settings.json, the remembered words in `bebe/偏好.md`. */
export function BebeSettings({ pet, onPetChange, profile, profileError, onProfileChange }: {
  pet: PetSettings;
  onPetChange: (pet: PetSettings) => void;
  profile: PetProfile | null;
  profileError: string | null;
  onProfileChange: (profile: PetProfile) => void;
}) {
  const [tab, setTab] = useState<BebeTab>("reminders");
  const [text, setText] = useState("");
  const tabs: Array<{ id: BebeTab; label: string }> = [
    { id: "reminders", label: "提醒" },
    { id: "quiet", label: `安静时段 · ${pet.quietHours.length}` },
    ...(["style", "about"] as const).map((id) => ({ id, label: `${PROFILE_SECTIONS[id].label} · ${profile?.[id].length ?? "…"}` })),
  ];

  function setQuiet(index: number, patch: Partial<QuietHours>) {
    onPetChange({ ...pet, quietHours: pet.quietHours.map((quiet, at) => (at === index ? { ...quiet, ...patch } : quiet)) });
  }

  function toggleDay(index: number, day: Weekday) {
    const days = pet.quietHours[index].days;
    setQuiet(index, { days: WEEKDAYS.map((item) => item.id).filter((id) => (id === day ? !days.includes(id) : days.includes(id))) });
  }

  function setItems(section: ProfileSection, items: string[]) {
    if (profile) onProfileChange({ ...profile, [section]: items });
  }

  function addItem(section: ProfileSection) {
    const value = text.trim();
    if (!profile || !value || profile[section].includes(value)) return;
    setItems(section, [...profile[section], value]);
    setText("");
  }

  return (
    <>
      <div className="prompt-nav bebe-nav" role="tablist" aria-label="bebe 设置">
        {tabs.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "active" : ""} onClick={() => { setTab(item.id); setText(""); }}>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {tab === "reminders" && (
        <>
          <p className="rule-help">摸鱼提醒要同时满足「占比」和「连续」两个条件；晚间总结跟着睡眠时段算。</p>
          <div className="bebe-number-grid">
            {PET_NUMBER_FIELDS.map((field) => (
              <label className="settings-field-card" key={field.key}>
                <span>{field.label}（{field.unit}）</span>
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step="1"
                  value={pet[field.key]}
                  onChange={(event) => onPetChange({ ...pet, [field.key]: Math.min(field.max, Math.max(field.min, Math.round(Number(event.target.value)) || field.min)) })}
                />
              </label>
            ))}
          </div>
        </>
      )}

      {tab === "quiet" && (
        <>
          <p className="rule-help">安静时段里不弹摸鱼提醒、分类询问和习惯提醒；你让 bebe 定的一次性提醒照样会弹。结束早于开始表示跨过午夜。</p>
          {pet.quietHours.length === 0 ? (
            <div className="settings-note">还没有安静时段。</div>
          ) : (
            <ul className="rule-list quiet-list">
              {pet.quietHours.map((quiet, index) => (
                <li key={index}>
                  <span className="quiet-days" role="group" aria-label="星期">
                    {WEEKDAYS.map((day) => (
                      <button key={day.id} type="button" className={quiet.days.includes(day.id) ? "is-on" : ""} aria-pressed={quiet.days.includes(day.id)} onClick={() => toggleDay(index, day.id)}>
                        {day.label.slice(1)}
                      </button>
                    ))}
                  </span>
                  <span className="quiet-range">
                    <input type="time" value={quiet.start} onChange={(event) => setQuiet(index, { start: event.target.value })} aria-label="开始" />
                    <span aria-hidden="true">–</span>
                    <input type="time" value={quiet.end} onChange={(event) => setQuiet(index, { end: event.target.value })} aria-label="结束" />
                  </span>
                  <button type="button" className="icon-button" onClick={() => onPetChange({ ...pet, quietHours: pet.quietHours.filter((_, at) => at !== index) })} aria-label="删除这段安静时段" title="删除">
                    <X size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="secondary-button bebe-add" onClick={() => onPetChange({ ...pet, quietHours: [...pet.quietHours, NEW_QUIET] })} disabled={pet.quietHours.length >= 20}>
            <Plus size={15} /> 添加安静时段
          </button>
        </>
      )}

      {(tab === "style" || tab === "about") && (
        <>
          <p className="rule-help">{PROFILE_SECTIONS[tab].help}。存在数据文件夹的 <code>bebe/偏好.md</code>，在 Obsidian 里改也可以；在对话里说「记住……」时，AI 会先出确认卡。</p>
          {profile ? (
            <>
              <form className="rule-add" onSubmit={(event) => { event.preventDefault(); addItem(tab); }}>
                <input value={text} onChange={(event) => setText(event.target.value)} placeholder={tab === "style" ? "例如：少用感叹号" : "例如：周三下午要上课"} aria-label={`新的${PROFILE_SECTIONS[tab].label}`} />
                <button type="submit" className="secondary-button" disabled={!text.trim()}><Plus size={15} /> 添加</button>
              </form>
              {profile[tab].length === 0 ? (
                <div className="settings-note">还没有记住的话。</div>
              ) : (
                <ul className="rule-list preference-list">
                  {profile[tab].map((item, index) => (
                    <li key={index}>
                      {/* Items written in Obsidian can span lines; a textarea keeps them intact. */}
                      {item.includes("\n") ? (
                        <textarea rows={item.split("\n").length} value={item} onChange={(event) => setItems(tab, profile[tab].map((value, at) => (at === index ? event.target.value : value)))} aria-label={`第 ${index + 1} 条`} />
                      ) : (
                        <input value={item} onChange={(event) => setItems(tab, profile[tab].map((value, at) => (at === index ? event.target.value : value)))} aria-label={`第 ${index + 1} 条`} />
                      )}
                      <button type="button" className="icon-button" onClick={() => setItems(tab, profile[tab].filter((_, at) => at !== index))} aria-label={`删除「${item}」`} title="删除">
                        <X size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="settings-note">{profileError ?? "正在读取 bebe 偏好…"}</div>
          )}
        </>
      )}
    </>
  );
}
