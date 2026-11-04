import { type ReactNode, useEffect, useState } from "react";

/** The width of a chart's box, kept current as it resizes. */
export function useChartWidth(initial = 600) {
  const [node, ref] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    if (node === null) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return { ref, width };
}

/** What a chart shows until its first answer. */
export function ChartLoading() {
  return <p className="text-sm text-muted-foreground">Loading…</p>;
}

export function Legend(
  { items }: { items: { label: string; color: string }[] },
) {
  return (
    <div className="mb-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1">
          <i
            className="inline-block h-2 w-2 rounded-sm"
            style={{ background: item.color }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function ChartTooltip(
  { x, children }: { x: number; children: ReactNode },
) {
  return (
    <div
      className="pointer-events-none absolute top-1 rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-sm tabular-nums"
      style={{ left: x }}
    >
      {children}
    </div>
  );
}

/** Colours a chart's axis text and grid from the theme, in both modes. */
export const AXIS_TEXT = "var(--swamp-chart-label)";
export const AXIS_GRID = "var(--swamp-chart-grid)";
