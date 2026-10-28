import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EmotionType, LifeStage, Memory, MemoryMetadata } from "../types";
import { matchesSongQuery, memoryHasLocation, splitMemoryLocations } from "../memoryLogic";
import { MemoryConstellation } from "./MemoryConstellation";
import { MemoryCreateSheet } from "./MemoryCreateSheet";
import { MemoryEditor } from "./MemoryEditor";
import { MemoryInsights } from "./MemoryInsights";

interface MemoriesViewProps {
  hasApiKey: boolean;
  onOpenSettings: () => void;
}

export function MemoriesView({ hasApiKey, onOpenSettings }: MemoriesViewProps) {
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const topSectionRef = useRef<HTMLElement>(null);
  const splitterDrag = useRef<
    | { type: "vertical"; startX: number; startWidth: number }
    | { type: "horizontal"; startY: number; startHeight: number }
    | null
  >(null);
  const memoryReadVersion = useRef(0);
  const [memories, setMemories] = useState<MemoryMetadata[]>([]);
  const [lifeStages, setLifeStages] = useState<LifeStage[]>([]);
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);
  const [createMemoryDraft, setCreateMemoryDraft] = useState<Memory | null>(null);
  const [previewIntensity, setPreviewIntensity] = useState<{ id: string; intensity: number } | null>(null);
  const [selectedEmotions, setSelectedEmotions] = useState<EmotionType[]>([]);
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [songQuery, setSongQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [memoryLoadError, setMemoryLoadError] = useState<string | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(400);
  const [topSectionHeight, setTopSectionHeight] = useState<number | null>(null);

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const drag = splitterDrag.current;
      if (!drag) return;
      if (drag.type === "vertical") {
        const width = splitContainerRef.current?.clientWidth ?? window.innerWidth;
        const nextWidth = Math.max(280, Math.min(width - 306, drag.startWidth + drag.startX - event.clientX));
        setRightPanelWidth(nextWidth);
      } else {
        const availableHeight = topSectionRef.current?.parentElement?.clientHeight ?? window.innerHeight;
        const maxHeight = Math.max(180, availableHeight - 186);
        setTopSectionHeight(Math.max(180, Math.min(maxHeight, drag.startHeight + event.clientY - drag.startY)));
      }
    };
    const onMouseUp = () => {
      if (!splitterDrag.current) return;
      splitterDrag.current = null;
      document.body.classList.remove("dragging-vertical-splitter", "dragging-horizontal-splitter");
      document.querySelectorAll(".memory-splitter.dragging").forEach((splitter) => splitter.classList.remove("dragging"));
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.classList.remove("dragging-vertical-splitter", "dragging-horizontal-splitter");
    };
  }, []);

  async function loadData(showLoading = true) {
    try {
      if (showLoading) setLoading(true);
      setError(null);
      const [memoriesData, stagesData] = await Promise.all([
        invoke<MemoryMetadata[]>("list_memories"),
        invoke<LifeStage[]>("load_life_stages"),
      ]);
      setMemories(memoriesData);
      setLifeStages(stagesData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  const locations = useMemo(
    () => [...new Set(memories.flatMap((memory) => splitMemoryLocations(memory.location)))].sort((a, b) => a.localeCompare(b, "zh-CN")),
    [memories],
  );

  const filteredMemories = useMemo(
    () => memories.filter((memory) =>
      matchesSongQuery(memory.song, songQuery) &&
      (selectedEmotions.length === 0 || selectedEmotions.includes(memory.emotion.type)) &&
      (selectedLocations.length === 0 || selectedLocations.some((location) => memoryHasLocation(memory.location, location)))
    ),
    [memories, selectedEmotions, selectedLocations, songQuery],
  );

  async function handleSaveMemory(memory: Memory) {
    try {
      const now = new Date().toISOString();
      await invoke("save_memory", {
        memory: {
          ...memory,
          stage: memory.stage.trim() || null,
          createdAt: memory.createdAt || now,
          updatedAt: now,
        },
      });
      await loadData(false);
      setSelectedMemory(null);
      setPreviewIntensity(null);
    } catch (err) {
      throw err;
    }
  }

  async function handleDeleteMemory(id: string) {
    try {
      await invoke("delete_memory", { id });
      await loadData(false);
      if (selectedMemory?.id === id) setSelectedMemory(null);
      setPreviewIntensity((current) => current?.id === id ? null : current);
    } catch (err) {
      throw err;
    }
  }

  const handleMemoryClick = useCallback(async (memory: MemoryMetadata) => {
    const readVersion = memoryReadVersion.current + 1;
    memoryReadVersion.current = readVersion;
    setCreateMemoryDraft(null);
    setSelectedMemory(null);
    setPreviewIntensity(null);
    setMemoryLoadError(null);
    setMemoryLoading(true);
    try {
      const loadedMemory = await invoke<Memory>("read_memory", { id: memory.id });
      if (memoryReadVersion.current !== readVersion) return;
      setSelectedMemory({ ...loadedMemory, stage: loadedMemory.stage || "" });
    } catch (err) {
      if (memoryReadVersion.current !== readVersion) return;
      setMemoryLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (memoryReadVersion.current === readVersion) setMemoryLoading(false);
    }
  }, []);

  async function reloadSelectedMemory() {
    if (!selectedMemory) return;
    const readVersion = memoryReadVersion.current + 1;
    memoryReadVersion.current = readVersion;
    setMemoryLoadError(null);
    setMemoryLoading(true);
    try {
      const loadedMemory = await invoke<Memory>("read_memory", { id: selectedMemory.id });
      if (memoryReadVersion.current !== readVersion) return;
      setSelectedMemory({ ...loadedMemory, stage: loadedMemory.stage || "" });
      setPreviewIntensity(null);
    } catch (err) {
      if (memoryReadVersion.current !== readVersion) return;
      setMemoryLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (memoryReadVersion.current === readVersion) setMemoryLoading(false);
    }
  }

  function handleNewMemory() {
    const now = new Date();
    const quarter = Math.ceil((now.getMonth() + 1) / 3);
    const timestamp = now.toISOString();
    memoryReadVersion.current += 1;
    setMemoryLoadError(null);
    setMemoryLoading(false);
    setCreateMemoryDraft({
      id: "",
      song: "",
      date: `${now.getFullYear()}Q${quarter}`,
      stage: "",
      location: "",
      emotion: { type: "nostalgic", intensity: 5 },
      content: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async function handleCreateMemory(memory: Memory) {
    const now = new Date().toISOString();
    await invoke("save_memory", {
      memory: {
        ...memory,
        stage: memory.stage.trim() || null,
        createdAt: memory.createdAt || now,
        updatedAt: now,
      },
    });
    const refreshedMemories = await invoke<MemoryMetadata[]>("list_memories");
    setMemories(refreshedMemories);
  }

  function toggleEmotion(emotion: EmotionType) {
    setSelectedEmotions((current) =>
      current.includes(emotion) ? current.filter((item) => item !== emotion) : [...current, emotion],
    );
  }

  function toggleLocation(location: string) {
    setSelectedLocations((current) =>
      current.includes(location) ? current.filter((item) => item !== location) : [...current, location],
    );
  }

  function resetFilters() {
    setSongQuery("");
    setSelectedEmotions([]);
    setSelectedLocations([]);
  }

  if (loading) {
    return <div className="memories-view loading">加载中...</div>;
  }

  if (error) {
    return <div className="memories-view error">加载失败: {error}</div>;
  }

  const splitStyle = { "--memory-right-width": `${rightPanelWidth}px` } as CSSProperties;

  return (
    <div className="memories-view">
      <div className="memories-split-container" ref={splitContainerRef} style={splitStyle}>
        <div className="memories-constellation-pane">
          <MemoryConstellation
            memories={filteredMemories}
            previewIntensity={previewIntensity}
            lifeStages={lifeStages}
            selectedMemory={selectedMemory}
            songQuery={songQuery}
            selectedEmotions={selectedEmotions}
            selectedLocations={selectedLocations}
            locations={locations}
            onToggleEmotion={toggleEmotion}
            onToggleLocation={toggleLocation}
            onSongQueryChange={setSongQuery}
            onResetFilters={resetFilters}
            onMemoryClick={handleMemoryClick}
            onNewMemory={handleNewMemory}
          />
        </div>

        <div
          className="memory-splitter memory-splitter-vertical"
          role="separator"
          aria-label="调整星图和信息面板宽度"
          aria-orientation="vertical"
          tabIndex={0}
          onMouseDown={(event) => {
            splitterDrag.current = {
              type: "vertical",
              startX: event.clientX,
              startWidth: splitContainerRef.current?.lastElementChild instanceof HTMLElement
                ? splitContainerRef.current.lastElementChild.getBoundingClientRect().width
                : rightPanelWidth,
            };
            event.currentTarget.classList.add("dragging");
            document.body.classList.add("dragging-vertical-splitter");
            event.preventDefault();
          }}
        />

        <aside className="memories-right-panel">
          <section
            ref={topSectionRef}
            className="memory-insights-pane"
            style={topSectionHeight ? { flex: `0 0 ${topSectionHeight}px` } : undefined}
          >
            <MemoryInsights
              memories={filteredMemories}
              lifeStages={lifeStages}
              selectedMemory={selectedMemory}
              onMemoryClick={handleMemoryClick}
            />
          </section>

          <div
            className="memory-splitter memory-splitter-horizontal"
            role="separator"
            aria-label="调整热力图和记忆编辑器高度"
            aria-orientation="horizontal"
            tabIndex={0}
            onMouseDown={(event) => {
              splitterDrag.current = {
                type: "horizontal",
                startY: event.clientY,
                startHeight: topSectionRef.current?.getBoundingClientRect().height ?? 220,
              };
              event.currentTarget.classList.add("dragging");
              document.body.classList.add("dragging-horizontal-splitter");
              event.preventDefault();
            }}
          />

          <section className="memories-editor-pane">
            {memoryLoadError ? (
              <div className="memories-editor-empty" aria-live="polite">
                <span className="memories-editor-error">无法读取记忆：{memoryLoadError}</span>
              </div>
            ) : memoryLoading && !selectedMemory ? (
              <div className="memories-editor-empty" aria-live="polite"><span>正在加载记忆正文…</span></div>
            ) : selectedMemory ? (
              <MemoryEditor
                key={selectedMemory.id || "new-memory"}
                memory={selectedMemory}
                lifeStages={lifeStages}
                onSave={handleSaveMemory}
                onDelete={handleDeleteMemory}
                onIntensityPreview={(id, intensity) => setPreviewIntensity({ id, intensity })}
                onReload={reloadSelectedMemory}
                bodyLoading={memoryLoading}
                onClose={() => {
                  memoryReadVersion.current += 1;
                  setMemoryLoadError(null);
                  setMemoryLoading(false);
                  setSelectedMemory(null);
                  setPreviewIntensity(null);
                }}
              />
            ) : (
              <div className="memories-editor-empty" aria-live="polite">
                <span>未选择记忆</span>
              </div>
            )}
          </section>
        </aside>
      </div>
      {createMemoryDraft && (
        <MemoryCreateSheet
          initialMemory={createMemoryDraft}
          lifeStages={lifeStages}
          hasApiKey={hasApiKey}
          onSave={handleCreateMemory}
          onClose={() => setCreateMemoryDraft(null)}
          onOpenSettings={onOpenSettings}
        />
      )}
    </div>
  );
}
