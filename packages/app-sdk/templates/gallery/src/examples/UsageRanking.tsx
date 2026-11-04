import { scaleLinear } from "d3-scale";
import { useRequest } from "@swamp-club/app-sdk/react";
import { ChartLoading, useChartWidth } from "../charts/chart_parts.tsx";

const ROW = 24;
const LABEL_WIDTH = 150;
const VALUE_WIDTH = 44;

/** Needs `runs:read`. A ranked bar with its value beside it. */
export function UsageRanking({ since = "30d" }: { since?: string }) {
  const { data, error } = useRequest("model.usage.summary", {
    since,
  });
  const { ref, width } = useChartWidth();
  if (error !== null) return <p className="text-sm">{error}</p>;
  if (data === null) return <ChartLoading />;
  const rows = [...data.data.models]
    .sort((a, b) => b.executions - a.executions)
    .slice(0, 8);
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }
  const x = scaleLinear()
    .domain([0, rows[0]?.executions ?? 1])
    .range([0, Math.max(width - LABEL_WIDTH - VALUE_WIDTH, 0)]);
  return (
    <div ref={ref}>
      <svg
        width={width}
        height={rows.length * ROW}
        role="img"
        aria-label="Executions by behavior"
      >
        {rows.map((row, index) => (
          <g key={row.modelName} transform={`translate(0 ${index * ROW})`}>
            <text y={15} fontSize={11} fill="var(--swamp-text-2)">
              {row.modelName.slice(0, 22)}
            </text>
            <rect
              x={LABEL_WIDTH}
              y={5}
              width={x(row.executions)}
              height={12}
              rx={2}
              fill="var(--chart-1)"
            >
              <title>
                {row.executions} executions, {row.failed} failed
              </title>
            </rect>
            <text
              x={LABEL_WIDTH + x(row.executions) + 6}
              y={15}
              fontSize={11}
              fill="var(--swamp-text-2)"
            >
              {row.executions}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
