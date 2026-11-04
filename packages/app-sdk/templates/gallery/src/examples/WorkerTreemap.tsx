import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { useRequest } from "@swamp-club/app-sdk/react";
import { ChartLoading, useChartWidth } from "../charts/chart_parts.tsx";

interface Node {
  name: string;
  value?: number;
  status?: string;
  children?: Node[];
}

const HEIGHT = 180;

/** Needs `workers:read`. One tile per worker, sized by what it is running. */
export function WorkerTreemap() {
  const { data, error } = useRequest("worker.list", {});
  const { ref, width } = useChartWidth();
  if (error !== null) return <p className="text-sm">{error}</p>;
  if (data === null) return <ChartLoading />;
  const workers = data.data.workers;
  if (workers.length === 0) {
    return <p className="text-sm text-muted-foreground">No workers.</p>;
  }
  const root = hierarchy<Node>({
    name: "workers",
    children: workers.map((worker) => ({
      name: worker.name,
      status: worker.status,
      value: 1 + worker.activeDispatchIds.length,
    })),
  }).sum((node) => node.value ?? 0);
  const layout = treemap<Node>()
    .tile(treemapSquarify)
    .size([width, HEIGHT])
    .padding(2)(root);
  return (
    <div ref={ref}>
      <svg width={width} height={HEIGHT} role="img" aria-label="Workers">
        {layout.leaves().map((leaf) => (
          <g key={leaf.data.name}>
            <rect
              x={leaf.x0}
              y={leaf.y0}
              width={leaf.x1 - leaf.x0}
              height={leaf.y1 - leaf.y0}
              rx={3}
              fill={leaf.data.status === "busy"
                ? "var(--swamp-running)"
                : leaf.data.status === "idle"
                ? "var(--chart-3)"
                : "var(--swamp-cancelled)"}
            >
              <title>{leaf.data.name}: {leaf.data.status}</title>
            </rect>
            <text
              x={leaf.x0 + 6}
              y={leaf.y0 + 15}
              fontSize={11}
              fill="var(--swamp-surface)"
            >
              {leaf.data.name.slice(0, 18)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
