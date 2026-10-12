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
import { useEffect, useId, useRef } from "react";
import {
  type DagLayoutOptions,
  layoutDag,
  type MiniDagEdge,
  type MiniDagNode,
} from "../lib/mini_dag_layout.ts";

export type { MiniDagEdge, MiniDagNode } from "../lib/mini_dag_layout.ts";

interface ScrollBox {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
}

interface MiniDagProps {
  nodes: readonly MiniDagNode[];
  /** `from` runs before `to`. Edges naming unknown nodes are skipped. */
  edges: readonly MiniDagEdge[];
  /**
   * Nodes to emphasise. When set, the rest are muted and only edges
   * between emphasised nodes are drawn in the accent color.
   */
  highlight?: readonly string[];
  /** Accessible name for the whole graph ("Jobs of deploy"). */
  label: string;
  /** Geometry overrides; see `DAG_DEFAULTS`. */
  layout?: DagLayoutOptions;
}

/**
 * A small left-to-right DAG: one column per dependency depth, an edge per
 * dependency. Node tones follow run statuses (`succeeded`, `failed`,
 * `running`, `suspended`, `cancelled`, `pending`) plus `waiting` for work
 * held back by something upstream. Wide graphs scroll horizontally.
 *
 * Styles live in `src/styles/mini-dag.css`; a view that renders a MiniDag
 * imports that stylesheet once (components stay importable from tests).
 */
export function MiniDag(
  { nodes, edges, highlight = [], label, layout: options }: MiniDagProps,
) {
  const markerId = `mini-dag-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const scrollRef = useRef<HTMLDivElement>(null);
  const layout = layoutDag(nodes, edges, options);
  const emphasised = new Set(highlight);
  // A graph wider than its box opens scrolled to the first highlighted
  // node, so on a narrow screen the part that matters is in view.
  const firstHighlight = layout.nodes.find((n) => emphasised.has(n.id));
  const focusX = firstHighlight?.x ?? 0;
  useEffect(() => {
    // Typed structurally: the component also type-checks without DOM libs.
    const el = scrollRef.current as unknown as ScrollBox | null;
    if (!el || focusX === 0 || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = Math.max(0, focusX - el.clientWidth / 4);
  }, [focusX]);
  const focusing = emphasised.size > 0;
  const predecessors = new Map<string, string[]>();
  for (const e of layout.edges) {
    const list = predecessors.get(e.to) ?? [];
    list.push(e.from);
    predecessors.set(e.to, list);
  }

  if (layout.nodes.length === 0) return null;

  return (
    <div
      className="mini-dag"
      role="group"
      aria-label={label}
      ref={scrollRef}
      // Scrollable regions must be reachable by keyboard.
      tabIndex={layout.width > 0 ? 0 : undefined}
    >
      <div
        className="mini-dag-canvas"
        style={{ width: layout.width, height: layout.height }}
      >
        <svg
          className="mini-dag-edges"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            {["", "-hl"].map((suffix) => (
              <marker
                key={suffix}
                id={`${markerId}${suffix}`}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path
                  d="M 0 0 L 8 4 L 0 8 z"
                  className={`mini-dag-arrow${suffix ? " hl" : ""}`}
                />
              </marker>
            ))}
          </defs>
          {layout.edges.map((e) => {
            const hl = emphasised.has(e.from) && emphasised.has(e.to);
            return (
              <path
                key={`${e.from}->${e.to}`}
                d={e.path}
                className={`mini-dag-edge${hl ? " hl" : ""}`}
                markerEnd={`url(#${markerId}${hl ? "-hl" : ""})`}
              />
            );
          })}
        </svg>
        <ul className="mini-dag-nodes">
          {layout.nodes.map((n) => {
            const after = predecessors.get(n.id) ?? [];
            const classes = [
              "mini-dag-node",
              `tone-${n.status ?? "none"}`,
              focusing && emphasised.has(n.id) ? "hl" : "",
              focusing && !emphasised.has(n.id) ? "muted" : "",
            ].filter(Boolean).join(" ");
            return (
              <li
                key={n.id}
                className={classes}
                title={n.title ?? n.label}
                style={{
                  left: n.x,
                  top: n.y,
                  width: layout.nodeWidth,
                  height: layout.nodeHeight,
                }}
              >
                <span className="mini-dag-label">{n.label}</span>
                {(n.status || after.length > 0) && (
                  <span className="visually-hidden">
                    {n.status ? `, ${n.status}` : ""}
                    {after.length > 0 ? `, after ${after.join(", ")}` : ""}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
