import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  ImagePlus,
  LoaderCircle,
  MessageSquareText,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { hourLabel } from "../boardLogic";
import type {
  AiChatMessage,
  AiProposalItem,
  AiReply,
  AppSettings,
  ImageAttachment,
  PeriodId,
} from "../types";

interface AiPanelProps {
  settings: AppSettings;
  hasApiKey: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onImport: (items: AiProposalItem[]) => void;
}

function fileAsAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.onload = () =>
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type || "image/png",
        dataUrl: String(reader.result),
      });
    reader.readAsDataURL(file);
  });
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "AI 请求失败，请检查 Provider 设置后重试。";
}

export function AiPanel({
  settings,
  hasApiKey,
  onClose,
  onOpenSettings,
  onImport,
}: AiPanelProps) {
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [proposals, setProposals] = useState<AiProposalItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, proposals, loading]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);

  async function addFiles(files: FileList | null) {
    if (!files) return;
    setError(null);
    try {
      const next = await Promise.all(Array.from(files).slice(0, 4).map(fileAsAttachment));
      setAttachments((current) => [...current, ...next].slice(0, 4));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function sendMessage() {
    const content = input.trim();
    if ((!content && attachments.length === 0) || loading) return;
    if (!hasApiKey) {
      setError("请先在 Settings → AI Provider 中保存 API key。 ");
      return;
    }
    if (attachments.length > 0 && !settings.ai.supportsImages) {
      setError("当前模型没有开启图片能力。请改用支持图片的兼容模型，或先粘贴图片中的文字。");
      return;
    }

    const userMessage: AiChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      images: attachments,
    };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setAttachments([]);
    setError(null);
    setLoading(true);

    try {
      const reply = await invoke<AiReply>("generate_ai_response", {
        request: {
          messages: nextMessages.map((message) => ({
            role: message.role,
            content: message.content,
            images: message.images?.map((image) => ({
              mimeType: image.mimeType,
              dataUrl: image.dataUrl,
            })),
          })),
        },
      });
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "assistant", content: reply.message },
      ]);
      setProposals(
        reply.status === "proposal"
          ? reply.items.map((item) => ({ ...item, id: crypto.randomUUID(), selected: true }))
          : [],
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  function updateProposal(id: string, patch: Partial<AiProposalItem>) {
    setProposals((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function importSelected() {
    const selected = proposals.filter((item) => item.selected && item.title.trim());
    if (selected.length === 0) return;
    onImport(selected);
    setProposals([]);
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `已将 ${selected.length} 个习惯添加到时间板最上方。`,
      },
    ]);
  }

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <aside
        className="side-sheet ai-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-panel-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sheet-header">
          <div>
            <span className="eyebrow">AI EXTRACT</span>
            <h2 id="ai-panel-title">把建议变成习惯</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </header>

        {!hasApiKey && (
          <button className="setup-callout" onClick={onOpenSettings}>
            <Sparkles size={18} />
            <span>
              <strong>先连接 {settings.ai.provider === "deepseek" ? "DeepSeek" : "兼容模型"}</strong>
              在 AI Provider 中保存 API key
            </span>
          </button>
        )}

        <div className="chat-scroll">
          {messages.length === 0 && (
            <div className="ai-empty">
              <div className="ai-orb"><MessageSquareText size={25} /></div>
              <h3>把长攻略交给我整理</h3>
              <p>粘贴文字，或为支持图片的模型附上截图。我会先生成待确认清单，不会直接修改时间板。</p>
            </div>
          )}

          {messages.map((message) => (
            <div key={message.id} className={`chat-message ${message.role}`}>
              {message.images && message.images.length > 0 && (
                <div className="message-images">
                  {message.images.map((image) => (
                    <img key={image.id} src={image.dataUrl} alt={image.name} />
                  ))}
                </div>
              )}
              {message.content && <p>{message.content}</p>}
            </div>
          ))}

          {loading && (
            <div className="chat-message assistant loading-message">
              <LoaderCircle className="spin" size={17} /> 正在提取可执行习惯…
            </div>
          )}

          {proposals.length > 0 && (
            <section className="proposal-section">
              <div className="proposal-title">
                <div>
                  <span className="eyebrow">REVIEW</span>
                  <h3>确认后再添加</h3>
                </div>
                <span>{proposals.filter((item) => item.selected).length}/{proposals.length}</span>
              </div>

              {proposals.map((item) => (
                <article key={item.id} className={`proposal-card ${item.selected ? "selected" : ""}`}>
                  <label className="proposal-check">
                    <input
                      type="checkbox"
                      checked={item.selected}
                      onChange={(event) => updateProposal(item.id, { selected: event.target.checked })}
                    />
                    <span><Check size={13} /></span>
                  </label>
                  <div className="proposal-fields">
                    <input
                      className="proposal-name"
                      value={item.title}
                      onChange={(event) => updateProposal(item.id, { title: event.target.value })}
                    />
                    <div className="proposal-row">
                      <select
                        value={item.placement.kind}
                        onChange={(event) => {
                          const kind = event.target.value as "period" | "hour";
                          updateProposal(item.id, {
                            placement:
                              kind === "hour"
                                ? { kind: "hour", hour: item.placement.hour ?? 9 }
                                : { kind: "period", period: item.placement.period ?? "morning" },
                          });
                        }}
                      >
                        <option value="period">时段</option>
                        <option value="hour">小时</option>
                      </select>
                      {item.placement.kind === "hour" ? (
                        <select
                          value={item.placement.hour ?? 9}
                          onChange={(event) =>
                            updateProposal(item.id, {
                              placement: { kind: "hour", hour: Number(event.target.value) },
                            })
                          }
                        >
                          {Array.from({ length: 24 }, (_, hour) => (
                            <option key={hour} value={hour}>{hourLabel(hour)}</option>
                          ))}
                        </select>
                      ) : (
                        <select
                          value={item.placement.period ?? "morning"}
                          onChange={(event) =>
                            updateProposal(item.id, {
                              placement: { kind: "period", period: event.target.value as PeriodId },
                            })
                          }
                        >
                          {settings.periods.map((period) => (
                            <option key={period.id} value={period.id}>{period.label}</option>
                          ))}
                        </select>
                      )}
                      <input
                        value={item.tags ?? ""}
                        onChange={(event) => updateProposal(item.id, { tags: event.target.value })}
                        placeholder="Tags"
                      />
                    </div>
                    {item.reason && <p className="proposal-reason">{item.reason}</p>}
                    {item.sourceExcerpt && <details><summary>查看原文依据</summary><p>{item.sourceExcerpt}</p></details>}
                  </div>
                </article>
              ))}

              <button className="primary-button full-button" onClick={importSelected}>
                <Check size={17} /> 添加所选习惯
              </button>
            </section>
          )}
          <div ref={chatEnd} />
        </div>

        <div className="composer">
          {attachments.length > 0 && (
            <div className="attachment-strip">
              {attachments.map((image) => (
                <div key={image.id} className="attachment-thumb">
                  <img src={image.dataUrl} alt={image.name} />
                  <button onClick={() => setAttachments((current) => current.filter((item) => item.id !== image.id))}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {error && <div className="inline-error">{error}</div>}
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void sendMessage();
            }}
            placeholder="粘贴攻略、描述你的想法，或回答 AI 的问题…"
            rows={4}
          />
          <div className="composer-actions">
            <div>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={(event) => void addFiles(event.target.files)}
              />
              <button className="secondary-button" onClick={() => fileInput.current?.click()} disabled={loading}>
                <ImagePlus size={16} /> 图片
              </button>
              <span className="shortcut-hint">⌘ Enter 发送</span>
            </div>
            <button
              className="primary-button"
              onClick={() => void sendMessage()}
              disabled={loading || (!input.trim() && attachments.length === 0)}
            >
              {loading ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
              发送
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
