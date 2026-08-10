"use client";

import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";

export interface ChartDatum {
  timestamp: string;
  value: number;
}

interface InteractiveAreaChartProps {
  data: ChartDatum[];
  color: string;
  valueLabel: string;
  yAxisLabel: string;
  xAxisLabel?: string;
  rankIsBetter?: boolean;
}

const SVG_WIDTH = 1_000;
const SVG_HEIGHT = 220;

export function InteractiveAreaChart({
  data,
  color,
  valueLabel,
  yAxisLabel,
  xAxisLabel = "Collection time",
  rankIsBetter = false,
}: InteractiveAreaChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const gradientId = `chart-fill-${useId().replaceAll(":", "")}`;
  const chart = useMemo(() => buildChart(data, rankIsBetter), [data, rankIsBetter]);
  const active = activeIndex === null ? null : chart.points[activeIndex];

  function selectNearestPoint(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
    const targetTime = chart.firstTime + ratio * chart.timeRange;
    setActiveIndex(nearestPointIndex(chart.points, targetTime));
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const fallback = event.key === "ArrowLeft" ? chart.points.length - 1 : 0;
    const next = activeIndex === null ? fallback : activeIndex + (event.key === "ArrowLeft" ? -1 : 1);
    setActiveIndex(clamp(next, 0, chart.points.length - 1));
  }

  return (
    <div className="interactive-chart">
      <div className="chart-y-axis-title">{yAxisLabel}</div>
      <div className="chart-y-ticks" aria-hidden="true">
        {chart.yTicks.map((tick) => (
          <span key={`${tick.value}-${tick.position}`} style={{ top: `${tick.position}%` }}>
            {formatAxisValue(tick.value, rankIsBetter)}
          </span>
        ))}
      </div>
      <div
        className="chart-plot"
        role="img"
        aria-label={`${valueLabel} history. X axis: ${xAxisLabel}. Y axis: ${yAxisLabel}.`}
        tabIndex={0}
        onFocus={() => setActiveIndex((current) => current ?? chart.points.length - 1)}
        onBlur={() => setActiveIndex(null)}
        onKeyDown={navigate}
        onPointerDown={selectNearestPoint}
        onPointerMove={selectNearestPoint}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setActiveIndex(null);
        }}
      >
        <svg viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity=".28" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {chart.yTicks.map((tick) => (
            <line
              className="chart-grid-line"
              key={`grid-${tick.value}-${tick.position}`}
              x1="0"
              x2={SVG_WIDTH}
              y1={(tick.position / 100) * SVG_HEIGHT}
              y2={(tick.position / 100) * SVG_HEIGHT}
            />
          ))}
          <path d={chart.areaPath} fill={`url(#${gradientId})`} />
          <path
            d={chart.linePath}
            fill="none"
            stroke={color}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {active ? (
          <>
            <span className="chart-crosshair" style={{ left: `${active.xPercent}%` }} />
            <span
              className="chart-active-dot"
              style={{ left: `${active.xPercent}%`, top: `${active.yPercent}%`, borderColor: color }}
            />
            <div
              className={`chart-tooltip ${active.xPercent > 72 ? "chart-tooltip-left" : ""} ${active.yPercent < 30 ? "chart-tooltip-below" : ""}`}
              style={{ left: `${active.xPercent}%`, top: `${active.yPercent}%` }}
            >
              <strong>{formatExactValue(active.value, rankIsBetter)} {rankIsBetter ? "" : valueLabel}</strong>
              <span>{formatExactTime(new Date(active.timestamp))}</span>
            </div>
          </>
        ) : null}
      </div>
      <div className="chart-x-ticks" aria-hidden="true">
        {chart.xTicks.map((tick) => (
          <span key={tick.timestamp} style={{ left: `${tick.position}%` }}>
            {formatAxisTime(new Date(tick.timestamp), chart.timeRange)}
          </span>
        ))}
      </div>
      <div className="chart-x-axis-title">{xAxisLabel}</div>
      <p className="chart-interaction-hint">Hover, tap, or use arrow keys for exact values</p>
    </div>
  );
}

interface ChartPoint extends ChartDatum {
  time: number;
  xPercent: number;
  yPercent: number;
}

function buildChart(data: ChartDatum[], rankIsBetter: boolean) {
  const sorted = [...data].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  const rawMin = Math.min(...sorted.map((point) => point.value));
  const rawMax = Math.max(...sorted.map((point) => point.value));
  const padding = rawMin === rawMax ? Math.max(1, Math.abs(rawMin) * 0.05) : 0;
  const min = Math.max(rankIsBetter ? 1 : 0, rawMin - padding);
  const max = rawMax + padding;
  const range = Math.max(1, max - min);
  const firstTime = Date.parse(sorted[0].timestamp);
  const lastTime = Date.parse(sorted.at(-1)?.timestamp ?? sorted[0].timestamp);
  const timeRange = Math.max(1, lastTime - firstTime);
  const points: ChartPoint[] = sorted.map((point) => {
    const time = Date.parse(point.timestamp);
    const xPercent = sorted.length === 1 ? 50 : ((time - firstTime) / timeRange) * 100;
    const normalized = (point.value - min) / range;
    const yPercent = (rankIsBetter ? normalized : 1 - normalized) * 100;
    return { ...point, time, xPercent, yPercent };
  });
  const linePath = points
    .map((point, index) => `${index ? "L" : "M"}${(point.xPercent / 100) * SVG_WIDTH},${(point.yPercent / 100) * SVG_HEIGHT}`)
    .join(" ");
  const firstX = (points[0].xPercent / 100) * SVG_WIDTH;
  const lastX = (points.at(-1)?.xPercent ?? points[0].xPercent) / 100 * SVG_WIDTH;
  const areaPath = `${linePath} L${lastX},${SVG_HEIGHT} L${firstX},${SVG_HEIGHT} Z`;
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const position = index * 25;
    const ratio = position / 100;
    const value = rankIsBetter ? min + range * ratio : max - range * ratio;
    return { position, value };
  });
  const xTicks = points.length === 1
    ? [{ timestamp: points[0].timestamp, position: 50 }]
    : [0, 0.5, 1].map((ratio) => ({
        timestamp: new Date(firstTime + timeRange * ratio).toISOString(),
        position: ratio * 100,
      }));
  return { points, yTicks, xTicks, linePath, areaPath, firstTime, timeRange };
}

function nearestPointIndex(points: ChartPoint[], targetTime: number): number {
  let nearest = 0;
  let smallestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const distance = Math.abs(points[index].time - targetTime);
    if (distance < smallestDistance) {
      nearest = index;
      smallestDistance = distance;
    }
  }
  return nearest;
}

function formatAxisValue(value: number, rank: boolean): string {
  if (rank) return `#${Math.max(1, Math.round(value))}`;
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatExactValue(value: number, rank: boolean): string {
  if (rank) return `Rank #${Math.round(value)}`;
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value);
}

function formatAxisTime(value: Date, timeRange: number): string {
  if (timeRange <= 48 * 60 * 60 * 1_000) {
    return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value);
  }
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(value);
}

function formatExactTime(value: Date): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
