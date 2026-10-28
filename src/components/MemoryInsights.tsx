import { useEffect, useMemo, useRef } from "react";
import type { LifeStage, Memory, MemoryMetadata } from "../types";
import { buildEmotionYearTable, getSimilarMemoryGroups, MEMORY_EMOTIONS } from "../memoryLogic";

interface MemoryInsightsProps {
  memories: MemoryMetadata[];
  lifeStages: LifeStage[];
  selectedMemory: Memory | null;
  onMemoryClick: (memory: MemoryMetadata) => void | Promise<void>;
}

export function MemoryInsights({ memories, lifeStages, selectedMemory, onMemoryClick }: MemoryInsightsProps) {
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartData = useMemo(() => buildEmotionYearTable(memories, lifeStages), [memories, lifeStages]);
  const recommendations = useMemo(
    () => selectedMemory ? getSimilarMemoryGroups(memories, selectedMemory) : null,
    [memories, selectedMemory],
  );
  const hasRecommendations = Boolean(recommendations && Object.values(recommendations).some((group) => group.length > 0));

  useEffect(() => {
    const canvas = chartRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width <= 0 || height <= 0) return;

      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.round(width * ratio);
      const pixelHeight = Math.round(height * ratio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      if (chartData.datedMemoryCount === 0) return;

      const padding = { top: 20, right: 15, bottom: 30, left: 60 };
      const chartWidth = Math.max(width - padding.left - padding.right, 1);
      const chartHeight = Math.max(height - padding.top - padding.bottom, 1);
      const cellWidth = chartWidth / chartData.years.length;
      const cellHeight = chartHeight / MEMORY_EMOTIONS.length;
      let maxCount = 0;
      MEMORY_EMOTIONS.forEach(({ value }) => chartData.counts[value].forEach((count) => { maxCount = Math.max(maxCount, count); }));

      MEMORY_EMOTIONS.forEach(({ value, label, color }, row) => {
        const red = Number.parseInt(color.slice(1, 3), 16);
        const green = Number.parseInt(color.slice(3, 5), 16);
        const blue = Number.parseInt(color.slice(5, 7), 16);
        chartData.years.forEach((year, column) => {
          const count = chartData.counts[value][column];
          const x = padding.left + column * cellWidth;
          const y = padding.top + row * cellHeight;
          const intensity = maxCount > 0 ? count / maxCount : 0;
          context.fillStyle = `rgba(${red}, ${green}, ${blue}, ${intensity * 0.9})`;
          context.fillRect(x, y, cellWidth, cellHeight);
          context.strokeStyle = "#fff";
          context.lineWidth = 0.5;
          context.strokeRect(x, y, cellWidth, cellHeight);
          if (count > 0) {
            context.fillStyle = intensity > 0.5 ? "#fff" : "#000";
            context.font = "7px Arial, sans-serif";
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(String(count), x + cellWidth / 2, y + cellHeight / 2);
          }
        });

        context.fillStyle = "#000";
        context.font = "8px Arial, sans-serif";
        context.textAlign = "right";
        context.textBaseline = "middle";
        context.fillText(label, padding.left - 6, padding.top + row * cellHeight + cellHeight / 2);
      });

      context.fillStyle = "#000";
      context.font = "8px Arial, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "top";
      chartData.years.forEach((year, index) => {
        if (index % 3 === 0) context.fillText(String(year), padding.left + index * cellWidth + cellWidth / 2, height - padding.bottom + 4);
      });
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    window.addEventListener("resize", draw);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", draw);
    };
  }, [chartData]);

  return (
    <section className="memory-insights-top">
      <div className="memory-chart-section">
        <h3 className="memory-chart-title">情绪 × 年份热力图</h3>
        <div className="memory-chart-frame">
          <canvas ref={chartRef} className="memory-emotion-chart" aria-label="按年份统计的情绪热力图" />
          {chartData.datedMemoryCount === 0 && <span className="memory-chart-empty">暂无可统计日期</span>}
        </div>
      </div>

      {hasRecommendations && recommendations && (
        <div className="memory-similar-groups" aria-label="相似记忆">
          {([
            ["同地点", recommendations.sameLocation],
            ["同情绪", recommendations.sameEmotion],
            ["同阶段", recommendations.sameStage],
          ] as const).map(([label, group]) => group.length > 0 && (
            <div className="memory-similar-row" key={label}>
              <span className="memory-similar-label">{label}</span>
              <div className="memory-similar-links">
                {group.map((memory) => (
                  <button
                    type="button"
                    className="memory-similar-link"
                    key={`${label}-${memory.id}`}
                    title={`${memory.song} · ${memory.date} · ${memory.location}`}
                    onClick={() => void onMemoryClick(memory)}
                  >
                    {memory.song || "未命名记忆"}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
