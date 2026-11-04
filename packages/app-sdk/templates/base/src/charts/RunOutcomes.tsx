import { useState } from "react";
import { scaleBand, scaleLinear } from "d3-scale";
import { max } from "d3-array";
import { useRequest } from "@swamp-club/app-sdk/react";
import {
  AXIS_GRID,
  AXIS_TEXT,
  ChartLoading,
  ChartTooltip,
  Legend,
  useChartWidth,
} from "./chart_parts.tsx";

const SERIES = [
  { key: "succeeded", label: "Succeeded", color: "var(--swamp-success)" },
  { key: "failed", label: "Failed", color: "var(--swamp-danger)" },
  { key: "cancelled", label: "Cancelled", color: "var(--swamp-cancelled)" },
] as const;

const HEIGHT = 180;
const MARGIN = { top: 8, right: 4, bottom: 20, left: 28 };
const MAX_BAR_WIDTH = 28;

/** Needs `runs:read`. React owns the DOM; d3 only does the scales. */
export function RunOutcomes({ since = "14d" }: { since?: string }) {
  const { data, error } = useRequest("workflow.run.summary", {
    since,
    timeline: true,
  });
  const { ref, width } = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);

  if (error !== null) return <p className="text-sm">{error}</p>;
  if (data === null) return <ChartLoading />;
  const buckets = data.data.timeline ?? [];
  if (buckets.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }
  const x = scaleBand<number>()
    .domain(buckets.map((_, index) => index))
    .range([MARGIN.left, width - MARGIN.right])
    .padding(0.2);
  const y = scaleLinear()
    .domain([0, max(buckets, (bucket) => bucket.runs) ?? 1])
    .nice()
    .range([HEIGHT - MARGIN.bottom, MARGIN.top]);

  // a lone bucket would otherwise fill the chart
  const barWidth = x.bandwidth() < MAX_BAR_WIDTH ? x.bandwidth() : MAX_BAR_WIDTH;

  return (
    <div ref={ref} className="relative">
      <Legend items={SERIES.map(({ label, color }) => ({ label, color }))} />
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label="Run outcomes over time"
      >
        {y.ticks(4).map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke={AXIS_GRID}
            />
            <text
              x={MARGIN.left - 6}
              y={y(tick) + 3}
              textAnchor="end"
              fontSize={10}
              fill={AXIS_TEXT}
            >
              {tick}
            </text>
          </g>
        ))}
        {buckets.map((bucket, index) => {
          let base = 0;
          return (
            <g
              key={bucket.start}
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(null)}
            >
              <rect
                x={x(index)}
                y={MARGIN.top}
                width={x.bandwidth()}
                height={HEIGHT - MARGIN.top - MARGIN.bottom}
                fill="transparent"
              />
              {SERIES.map(({ key, color }) => {
                const value = bucket[key];
                const top = y(base + value);
                const height = y(base) - top;
                base += value;
                return height > 2
                  ? (
                    <rect
                      key={key}
                      x={x(index)}
                      y={top}
                      width={barWidth}
                      height={height - 2}
                      rx={2}
                      fill={color}
                    />
                  )
                  : null;
              })}
            </g>
          );
        })}
      </svg>
      {hover !== null && buckets[hover] && (
        <ChartTooltip x={x(hover) ?? 0}>
          <div>{new Date(buckets[hover].start).toLocaleString()}</div>
          {SERIES.map(({ key, label }) => (
            <div key={key}>{buckets[hover][key]} {label.toLowerCase()}</div>
          ))}
        </ChartTooltip>
      )}
    </div>
  );
}
