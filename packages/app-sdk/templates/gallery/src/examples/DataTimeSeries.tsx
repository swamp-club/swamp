import { useMemo } from "react";
import { scaleLinear, scaleTime } from "d3-scale";
import { area, line } from "d3-shape";
import { extent, max, rollup } from "d3-array";
import { useRequest } from "@swamp-club/app-sdk/react";
import {
  AXIS_GRID,
  AXIS_TEXT,
  ChartLoading,
  useChartWidth,
} from "../charts/chart_parts.tsx";

const HEIGHT = 160;
const MARGIN = { top: 8, right: 8, bottom: 20, left: 28 };
const DAY_MS = 86_400_000;

/** Needs `data:read`; change `predicate`, and read a field instead of counting, to chart your own data. */
export function DataTimeSeries({ predicate = "true" }: { predicate?: string }) {
  const { data, error } = useRequest("data.query", {
    predicate,
    limit: 500,
    sort: { field: "createdAt", direction: "desc" },
  });
  const { ref, width } = useChartWidth();
  const points = useMemo(() => {
    const dates = data?.data.results.map((item) => new Date(item.createdAt).getTime()) ??
      [];
    const perDay = rollup(
      dates,
      (group) => group.length,
      (time) => Math.floor(time / DAY_MS) * DAY_MS,
    );
    return [...perDay.entries()]
      .map(([day, count]) => ({ day: new Date(day), count }))
      .sort((a, b) => a.day.getTime() - b.day.getTime());
  }, [data]);

  if (error !== null) return <p className="text-sm">{error}</p>;
  if (data === null) return <ChartLoading />;
  if (points.length === 0) {
    return <p className="text-sm text-muted-foreground">No data yet.</p>;
  }
  const [first, last] = extent(points, (point) => point.day);
  const x = scaleTime()
    .domain([first ?? new Date(), last ?? new Date()])
    .range([MARGIN.left, width - MARGIN.right]);
  const y = scaleLinear()
    .domain([0, max(points, (point) => point.count) ?? 1])
    .nice()
    .range([HEIGHT - MARGIN.bottom, MARGIN.top]);
  const stroke = line<typeof points[number]>()
    .x((point) => x(point.day))
    .y((point) => y(point.count));
  const fill = area<typeof points[number]>()
    .x((point) => x(point.day))
    .y0(y(0))
    .y1((point) => y(point.count));
  return (
    <div ref={ref}>
      <svg width={width} height={HEIGHT} role="img" aria-label="Items per day">
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
        <path d={fill(points) ?? ""} fill="var(--chart-1)" opacity={0.15} />
        <path
          d={stroke(points) ?? ""}
          fill="none"
          stroke="var(--chart-1)"
          strokeWidth={2}
        />
        {points.map((point) => (
          <circle
            key={point.day.getTime()}
            cx={x(point.day)}
            cy={y(point.count)}
            r={4}
            fill="var(--chart-1)"
          >
            <title>
              {point.day.toLocaleDateString()}: {point.count}
            </title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
