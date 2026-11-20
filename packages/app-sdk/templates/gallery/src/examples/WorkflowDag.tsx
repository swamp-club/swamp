import { useMemo } from "react";
import { max } from "d3-array";
import { useRequest } from "@swamp-club/app-sdk/react";
import { useChartWidth } from "../charts/chart_parts.tsx";

interface Job {
  name: string;
  dependsOn: { job: string }[];
}

const NODE_WIDTH = 120;
const NODE_HEIGHT = 28;
const COLUMN_GAP = 40;
const ROW_GAP = 10;

function dependencyNames(job: Job): string[] {
  return job.dependsOn.map((entry) => entry.job);
}

/** A job's column is one past its deepest dependency. */
function columns(jobs: readonly Job[]): Map<string, number> {
  const byName = new Map(jobs.map((job) => [job.name, job]));
  const depth = new Map<string, number>();
  const visit = (job: Job, seen: Set<string>): number => {
    const known = depth.get(job.name);
    if (known !== undefined) return known;
    if (seen.has(job.name)) return 0;
    seen.add(job.name);
    const parents = dependencyNames(job).flatMap((name) => {
      const parent = byName.get(name);
      return parent ? [visit(parent, seen) + 1] : [];
    });
    const value = max(parents) ?? 0;
    depth.set(job.name, value);
    return value;
  };
  for (const job of jobs) visit(job, new Set());
  return depth;
}

/** Needs `catalog:read`. Draws the first workflow's jobs left to right. */
export function WorkflowDag() {
  const search = useRequest("workflow.search", {});
  const first = search.data?.data.results[0]?.name;
  const workflow = useRequest(
    "workflow.get",
    { workflowIdOrName: first ?? "" },
    { enabled: first !== undefined },
  );
  const { ref, width } = useChartWidth();
  const jobs = workflow.data?.data.jobs;
  const layout = useMemo(() => {
    const depth = columns(jobs ?? []);
    const rows = new Map<number, number>();
    const placed = new Map<string, { x: number; y: number }>();
    for (const job of jobs ?? []) {
      const column = depth.get(job.name) ?? 0;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      placed.set(job.name, {
        x: column * (NODE_WIDTH + COLUMN_GAP),
        y: row * (NODE_HEIGHT + ROW_GAP),
      });
    }
    return placed;
  }, [jobs]);

  if (search.error !== null) return <p className="text-sm">{search.error}</p>;
  if (search.data !== null && first === undefined) {
    return <p className="text-sm text-muted-foreground">No workflows yet.</p>;
  }
  const points = [...layout.values()];
  const height = max(points, (point) => point.y + NODE_HEIGHT) ?? NODE_HEIGHT;
  const contentWidth = max(points, (point) => point.x + NODE_WIDTH) ?? 0;
  return (
    <div ref={ref} className="overflow-x-auto">
      <p className="mb-2 text-xs text-muted-foreground">{first}</p>
      <svg
        width={width > contentWidth ? width : contentWidth}
        height={height}
        role="img"
        aria-label="Jobs and their dependencies"
      >
        {(jobs ?? []).flatMap((job) =>
          dependencyNames(job).flatMap((parent) => {
            const from = layout.get(parent);
            const to = layout.get(job.name);
            if (!from || !to) return [];
            return [
              <line
                key={`${parent}-${job.name}`}
                x1={from.x + NODE_WIDTH}
                y1={from.y + NODE_HEIGHT / 2}
                x2={to.x}
                y2={to.y + NODE_HEIGHT / 2}
                stroke="var(--swamp-text-3)"
              />,
            ];
          })
        )}
        {(jobs ?? []).map((job) => {
          const point = layout.get(job.name);
          if (!point) return null;
          return (
            <g key={job.name} transform={`translate(${point.x} ${point.y})`}>
              <rect
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={4}
                fill="var(--swamp-surface-inset)"
                stroke="var(--swamp-border)"
              />
              <text
                x={8}
                y={18}
                fontSize={11}
                fill="var(--swamp-text-1)"
              >
                {job.name.slice(0, 16)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
