// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import type { CSSProperties, ReactNode } from "react";

// Loading placeholders shaped like the content they stand in for. Every
// block shares one shimmer pinned to the viewport, so a page of
// placeholders pulses as a single sheet instead of a hundred out-of-step
// bars. Placeholders fade in after a short delay so a fast response never
// flashes them, and the shimmer stops under prefers-reduced-motion.

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: CSSProperties;
  className?: string;
}

/** One placeholder block. */
export function Skeleton(
  { width = "100%", height = 12, radius, style, className }: SkeletonProps,
) {
  return (
    <span
      aria-hidden="true"
      className={`skel${className ? ` ${className}` : ""}`}
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

/**
 * Marks a region as loading for assistive tech and wraps its placeholders.
 * `label` is announced ("Loading workflows").
 */
export function SkeletonRegion(
  { label, children, style, className }: {
    label: string;
    children: ReactNode;
    style?: CSSProperties;
    className?: string;
  },
) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={`skel-region${className ? ` ${className}` : ""}`}
      style={style}
    >
      <span className="visually-hidden">{label}</span>
      {children}
    </div>
  );
}

// Fixed, varied widths read as text; random ones would reshuffle on every
// render.
const WIDTHS = ["62%", "48%", "74%", "55%", "68%", "40%", "58%", "70%"];

export function widthAt(i: number): string {
  return WIDTHS[i % WIDTHS.length];
}

/** Lines of placeholder text. */
export function SkeletonText(
  { lines = 3, lineHeight = 10, gap = 8 }: {
    lines?: number;
    lineHeight?: number;
    gap?: number;
  },
) {
  return (
    <span style={{ display: "flex", flexDirection: "column", gap }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          height={lineHeight}
          width={i === lines - 1 && lines > 1 ? "45%" : widthAt(i)}
        />
      ))}
    </span>
  );
}

/** The header's stat pills. */
export function SkeletonPills({ count = 4 }: { count?: number }) {
  return (
    <span style={{ display: "inline-flex", gap: 8 }} aria-hidden="true">
      {Array.from(
        { length: count },
        (_, i) => (
          <Skeleton key={i} width={i === 0 ? 96 : 78} height={28} radius={6} />
        ),
      )}
    </span>
  );
}

/** The run-history strip of a card or row. */
export function SkeletonRunHistory(
  { slots = 20, height = 6 }: { slots?: number; height?: number },
) {
  return (
    <span className="run-history" aria-hidden="true" style={{ height }}>
      {Array.from(
        { length: slots },
        (_, i) => (
          <Skeleton key={i} height={height} radius={1} style={{ flex: 1 }} />
        ),
      )}
    </span>
  );
}

/** A grid of cards: title + status, a meta line, and optionally a strip. */
export function SkeletonCardGrid(
  { count = 9, label, history = true }: {
    count?: number;
    label: string;
    history?: boolean;
  },
) {
  return (
    <SkeletonRegion label={label} className="card-grid">
      {Array.from(
        { length: count },
        (_, i) => (
          <div className="card skel-card" key={i}>
            <div className="card-header">
              <Skeleton width={widthAt(i)} height={14} />
              <Skeleton width={64} height={18} radius={4} />
            </div>
            <div className="card-meta">
              <Skeleton width={70} height={10} />
              <Skeleton width={50} height={10} />
            </div>
            {history && (
              <div style={{ marginTop: 12 }}>
                <SkeletonRunHistory />
              </div>
            )}
          </div>
        ),
      )}
    </SkeletonRegion>
  );
}

export interface SkeletonColumn {
  /** Real header text, so the table frame is final from the first paint. */
  header: string;
  /** Placeholder width: px, %, or "pill" / "strip" / "mono" presets. */
  cell?: number | string | "pill" | "strip" | "mono";
}

function SkeletonCell(
  { cell, row }: { cell: SkeletonColumn["cell"]; row: number },
) {
  if (cell === "pill") return <Skeleton width={72} height={18} radius={4} />;
  if (cell === "strip") {
    return (
      <span style={{ display: "block", width: 140 }}>
        <SkeletonRunHistory slots={12} height={10} />
      </span>
    );
  }
  if (cell === "mono") return <Skeleton width={64} height={10} />;
  return <Skeleton width={cell ?? widthAt(row)} height={10} />;
}

/** A table with real headers and placeholder rows. */
export function SkeletonTable(
  { columns, rows = 10, label }: {
    columns: SkeletonColumn[];
    rows?: number;
    label: string;
  },
) {
  return (
    <SkeletonRegion label={label} className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => <th key={c.header}>{c.header}</th>)}
          </tr>
        </thead>
        <tbody>
          {Array.from(
            { length: rows },
            (_, r) => (
              <tr key={r} className="skel-row">
                {columns.map((c, ci) => (
                  <td key={ci}>
                    <SkeletonCell cell={c.cell} row={r + ci} />
                  </td>
                ))}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </SkeletonRegion>
  );
}

/** Rows of a list panel: a dot, a title and detail line, a trailing value. */
export function SkeletonList(
  { rows = 6, label }: { rows?: number; label: string },
) {
  return (
    <SkeletonRegion label={label}>
      {Array.from(
        { length: rows },
        (_, i) => (
          <div className="skel-list-row" key={i}>
            <Skeleton width={8} height={8} radius="50%" />
            <span
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                flex: 1,
              }}
            >
              <Skeleton width={widthAt(i)} height={11} />
              <Skeleton width="30%" height={9} />
            </span>
            <Skeleton width={48} height={10} />
          </div>
        ),
      )}
    </SkeletonRegion>
  );
}

/** A panel with a header and list rows. */
export function SkeletonPanel(
  { rows = 5, label, title }: { rows?: number; label: string; title?: string },
) {
  return (
    <div className="panel">
      <div className="panel-header">
        {title
          ? <div className="panel-title">{title}</div>
          : <Skeleton width={120} height={12} />}
      </div>
      <SkeletonList rows={rows} label={label} />
    </div>
  );
}

/** Stat cards across the top of a detail page. */
export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div
      className="stats-grid"
      aria-hidden="true"
      style={{ gridTemplateColumns: `repeat(${count}, 1fr)` }}
    >
      {Array.from(
        { length: count },
        (_, i) => (
          <div className="stat-card" key={i}>
            <Skeleton width={70} height={10} style={{ marginBottom: 12 }} />
            <Skeleton width={i % 2 ? 54 : 80} height={26} />
          </div>
        ),
      )}
    </div>
  );
}
