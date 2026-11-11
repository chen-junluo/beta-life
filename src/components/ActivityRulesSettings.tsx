import { Plus, X } from "lucide-react";
import { useState } from "react";
import type { ActivityCategory, ActivityRules } from "../activity";
import { CategoryChip } from "./CategoryChip";

type RuleTab = "keywords" | "domains" | "apps";

const TABS: Array<{ id: RuleTab; label: string; help: string }> = [
  { id: "keywords", label: "标题关键词", help: "窗口标题包含关键词（不分大小写）时按这里算，优先于网站和应用；从上往下第一个命中的生效。例如 bilibili 算摸鱼，但标题含「课程」的算专注。" },
  { id: "domains", label: "网站", help: "按浏览器当前标签页的域名分类，子域名跟着主站（bilibili.com 也管 m.bilibili.com）；更具体的域名优先。可以直接粘贴网址。" },
  { id: "apps", label: "应用", help: "按前台应用分类。新应用在时间轴里点选或回答 bebe 的提问后出现在这里；浏览器这一条只管没有域名的页面。" },
];

/** Settings → 分类: the three rule lists, edited as a draft and saved with 保存设置. */
export function ActivityRulesSettings({ rules, onChange }: { rules: ActivityRules; onChange: (rules: ActivityRules) => void }) {
  const [tab, setTab] = useState<RuleTab>("keywords");
  const [text, setText] = useState("");
  const [category, setCategory] = useState<ActivityCategory>("focus");
  const active = TABS.find((item) => item.id === tab)!;

  const rows: Array<{ name: string; category: ActivityCategory }> =
    tab === "keywords" ? rules.keywords.map((rule) => ({ name: rule.keyword, category: rule.category }))
      : tab === "domains" ? rules.domains.map((rule) => ({ name: rule.domain, category: rule.category }))
        : rules.apps.map((rule) => ({ name: rule.name, category: rule.category }));

  function setAt(index: number, next: ActivityCategory) {
    onChange({ ...rules, [tab]: rules[tab].map((rule, at) => (at === index ? { ...rule, category: next } : rule)) });
  }

  function removeAt(index: number) {
    onChange({ ...rules, [tab]: rules[tab].filter((_, at) => at !== index) });
  }

  function add() {
    const value = text.trim();
    if (!value) return;
    if (tab === "keywords") onChange({ ...rules, keywords: [...rules.keywords.filter((rule) => rule.keyword.toLowerCase() !== value.toLowerCase()), { keyword: value, category }] });
    else onChange({ ...rules, domains: [...rules.domains.filter((rule) => rule.domain !== value), { domain: value, category }] });
    setText("");
  }

  function switchTab(next: RuleTab) {
    setTab(next);
    setText("");
    setCategory(next === "domains" ? "slack" : "focus");
  }

  return (
    <>
      <div className="prompt-nav rule-nav" role="tablist" aria-label="规则类型">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "active" : ""} onClick={() => switchTab(item.id)}>
            <span>{item.label} · {rules[item.id].length}</span>
          </button>
        ))}
      </div>
      <p className="rule-help">{active.help}</p>
      {tab !== "apps" && (
        <form className="rule-add" onSubmit={(event) => { event.preventDefault(); add(); }}>
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder={tab === "keywords" ? "例如：课程、lecture" : "例如：bilibili.com"} aria-label={tab === "keywords" ? "新关键词" : "新网站"} />
          <CategoryChip category={category} name="新规则" allowNone={false} onChange={(next) => next && setCategory(next)} />
          <button type="submit" className="secondary-button" disabled={!text.trim()}><Plus size={15} /> 添加</button>
        </form>
      )}
      {rows.length === 0 ? (
        <div className="settings-note">{tab === "keywords" ? "还没有关键词例外。" : "还没有规则。"}</div>
      ) : (
        <ul className="rule-list">
          {rows.map((row, index) => (
            <li key={`${row.name}-${index}`}>
              <span title={tab === "apps" ? rules.apps[index].key : row.name}>{row.name}</span>
              <CategoryChip category={row.category} name={row.name} allowNone={false} onChange={(next) => next && setAt(index, next)} />
              <button type="button" className="icon-button" onClick={() => removeAt(index)} aria-label={`删除 ${row.name}`} title="删除这条规则（之后算待分类）">
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
