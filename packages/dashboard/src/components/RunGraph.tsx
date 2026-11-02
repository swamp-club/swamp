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
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildPath, isPlainLeftClick, type RouteState } from "../routes.ts";
import { formatDuration } from "../lib/format.ts";
import {
  DEFAULT_LAYOUT,
  type Direction,
  edgePath,
  type GraphLayout,
  layoutGraph,
  neighborInDirection,
  relatives,
} from "./run_graph_layout.ts";
import {
  describeCondition,
  elapsed,
  isLive,
  jobSummary,
  type RunGraph as RunGraphData,
  type RunGraphEdge,
  type RunGraphJob,
} from "./run_graph_model.ts";
import { RunStatusIcon, statusLabel } from "./RunStatusIcon.tsx";
import { asDom, resizeObserverClass, type WheelLike } from "./dom_types.ts";

const PAD = 28;
/** Room above the graph for the zoom controls. */
const TOP = 56;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 560;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
/** Below this zoom card text is too small to read. */
const READABLE = 0.6;
/** Where a graph too big to fit readably starts: left-aligned, pan for more. */
const READABLE_START = 0.8;
const DRAG_THRESHOLD = 4;
/** Width assumed before the viewport has been measured (and when rendering on the server). */
const ASSUMED_WIDTH = 960;

interface View {
  x: number;
  y: number;
  k: number;
}

interface RunGraphProps {
  graph: RunGraphData;
  /** The job whose panel is open. */
  selected: string | null;
  onSelect: (job: string | null) => void;
  /** Clock for live durations, in ms since the epoch. */
  now: number;
  /** In-app navigation for plain clicks; links keep real hrefs. */
  onNavigate: (to: RouteState) => void;
}

/** The zoom a graph opens at: fitted when that stays readable. */
function openingZoom(fitted: number): number {
  return fitted >= READABLE ? fitted : READABLE_START;
}

/** The viewport height that shows the graph at its opening zoom. */
export function viewportHeight(layout: GraphLayout, width: number): number {
  if (layout.width === 0) return MIN_HEIGHT;
  const k = openingZoom(Math.min(1, (width - 2 * PAD) / layout.width));
  return Math.round(
    Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, layout.height * k + PAD + TOP)),
  );
}

/**
 * The view for the graph. `"all"` fits the whole graph, however small.
 * `"readable"` (on load) fits it too when the cards stay legible; a graph
 * too big for that opens at a readable zoom from its first column, where
 * the run starts, and is panned.
 */
export function fitView(
  layout: GraphLayout,
  width: number,
  height: number,
  mode: "readable" | "all" = "readable",
): View {
  if (layout.width === 0 || layout.height === 0) {
    return { x: PAD, y: TOP, k: 1 };
  }
  const fitted = Math.min(
    1,
    (width - 2 * PAD) / layout.width,
    (height - PAD - TOP) / layout.height,
  );
  const k = mode === "all" ? Math.max(MIN_ZOOM, fitted) : openingZoom(fitted);
  const x = layout.width * k <= width - 2 * PAD
    ? (width - layout.width * k) / 2
    : PAD;
  const y = Math.max(TOP, TOP + (height - TOP - PAD - layout.height * k) / 2);
  return { x: round(x), y: round(y), k: round(k, 1000) };
}

function round(n: number, by = 10): number {
  return Math.round(n * by) / by;
}

function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/**
 * The run's jobs as an interactive graph: cards laid out left to right by
 * dependency, curved edges between them. Drag to pan, ⌘/Ctrl + scroll or
 * pinch to zoom, arrow keys to move between jobs, Enter to open one.
 * Hovering or focusing a job lights its upstream and downstream paths.
 */
export function RunGraph(
  { graph, selected, onSelect, now, onNavigate }: RunGraphProps,
) {
  const hintId = useId();
  const layoutKey = useMemo(
    () =>
      JSON.stringify([
        graph.jobs.map((j) => j.name),
        graph.edges.map((e) => [e.from, e.to]),
      ]),
    [graph],
  );
  // Statuses change on every poll; positions only when the shape does.
  const layout = useMemo(
    () =>
      layoutGraph(
        graph.jobs.map((j) => ({ id: j.name })),
        graph.edges,
        DEFAULT_LAYOUT,
      ),
    [layoutKey],
  );

  const viewportRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(ASSUMED_WIDTH);
  const height = viewportHeight(layout, width);
  const [view, setView] = useState<View>(() =>
    fitView(layout, ASSUMED_WIDTH, viewportHeight(layout, ASSUMED_WIDTH))
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  /** The user has panned or zoomed: stop refitting on resize. */
  const adjusted = useRef(false);

  // Measure the viewport and keep the graph fitted until the user moves it.
  useEffect(() => {
    const el = viewportRef.current;
    const Observer = resizeObserverClass();
    if (!el || !Observer) return;
    const observer = new Observer((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    adjusted.current = false;
  }, [layoutKey]);

  useEffect(() => {
    if (!adjusted.current) setView(fitView(layout, width, height));
  }, [layout, width, height]);

  const fit = useCallback(() => {
    adjusted.current = false;
    setView(fitView(layout, width, height, "all"));
  }, [layout, width, height]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    adjusted.current = true;
    setView((v) => {
      const k = clampZoom(v.k * factor);
      const px = cx ?? width / 2;
      const py = cy ?? height / 2;
      return {
        k,
        x: px - (px - v.x) * (k / v.k),
        y: py - (py - v.y) * (k / v.k),
      };
    });
  }, [width, height]);

  // ⌘/Ctrl + wheel and trackpad pinch zoom; a plain wheel scrolls the page.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelLike) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = asDom(el).getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(
        Math.exp(-delta * 0.0025),
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
    };
    asDom(el).addEventListener("wheel", onWheel, { passive: false });
    return () => asDom(el).removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ── pan (drag) and pinch ─────────────────────────────────────────────
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    {
      start: { x: number; y: number };
      view: View;
      moved: boolean;
      pinch?: { distance: number; mid: { x: number; y: number } };
    } | null
  >(null);
  const swallowClick = useRef(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    swallowClick.current = false;
    const rect = asDom(e.currentTarget).getBoundingClientRect();
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        start: p,
        view: viewRef.current,
        moved: true,
        pinch: {
          distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        },
      };
    } else if (pointers.current.size === 1) {
      gesture.current = { start: p, view: viewRef.current, moved: false };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    const rect = asDom(e.currentTarget).getBoundingClientRect();
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    pointers.current.set(e.pointerId, p);
    if (g.pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const k = clampZoom(g.view.k * (distance / g.pinch.distance));
      adjusted.current = true;
      setView({
        k,
        x: mid.x - (g.pinch.mid.x - g.view.x) * (k / g.view.k),
        y: mid.y - (g.pinch.mid.y - g.view.y) * (k / g.view.k),
      });
      return;
    }
    const dx = p.x - g.start.x;
    const dy = p.y - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!g.moved) {
      g.moved = true;
      asDom(e.currentTarget).setPointerCapture?.(e.pointerId);
    }
    adjusted.current = true;
    setView({ k: g.view.k, x: g.view.x + dx, y: g.view.y + dy });
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.moved) swallowClick.current = true;
    if (pointers.current.size === 0) gesture.current = null;
  };

  // ── highlight and keyboard focus ─────────────────────────────────────
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const hot = hovered ?? focused;
  const related = useMemo(
    () => (hot ? relatives(hot, graph.edges) : null),
    [hot, graph.edges],
  );
  const lit = (id: string) =>
    !related || id === hot || related.upstream.has(id) ||
    related.downstream.has(id);
  const edgeLit = (e: RunGraphEdge) =>
    !!related && (
      ((e.to === hot || related.upstream.has(e.to)) &&
        related.upstream.has(e.from)) ||
      ((e.from === hot || related.downstream.has(e.from)) &&
        related.downstream.has(e.to))
    );

  const positions = useMemo(
    () => new Map(layout.nodes.map((n) => [n.id, n])),
    [layout],
  );
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const firstId = layout.levels[0]?.[0] ?? null;
  const tabStop = focused && positions.has(focused)
    ? focused
    : selected && positions.has(selected)
    ? selected
    : firstId;

  /** Pans just enough to bring a job fully into view. */
  const reveal = useCallback((id: string) => {
    const node = positions.get(id);
    if (!node) return;
    const v = viewRef.current;
    const margin = 16;
    const left = v.x + node.x * v.k;
    const right = left + DEFAULT_LAYOUT.nodeWidth * v.k;
    const top = v.y + node.y * v.k;
    const bottom = top + DEFAULT_LAYOUT.nodeHeight * v.k;
    let dx = 0;
    let dy = 0;
    if (left < margin) dx = margin - left;
    else if (right > width - margin) dx = width - margin - right;
    if (top < margin) dy = margin - top;
    else if (bottom > height - margin) dy = height - margin - bottom;
    if (dx !== 0 || dy !== 0) {
      adjusted.current = true;
      setView({ ...v, x: v.x + dx, y: v.y + dy });
    }
  }, [positions, width, height]);

  const onNodeKeyDown = (
    e: ReactKeyboardEvent<HTMLButtonElement>,
    id: string,
  ) => {
    const directions: Record<string, Direction> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    const direction = directions[e.key];
    let next: string | null = null;
    if (direction) next = neighborInDirection(layout, id, direction);
    else if (e.key === "Home") next = firstId;
    else if (e.key === "End") {
      const last = layout.levels[layout.levels.length - 1];
      next = last?.[last.length - 1] ?? null;
    } else return;
    e.preventDefault();
    if (next) {
      setFocused(next);
      reveal(next);
      const button = nodeRefs.current.get(next);
      if (button) asDom(button).focus({ preventScroll: true });
    }
  };

  const onGraphKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomAt(1.2);
    else if (e.key === "-" || e.key === "_") zoomAt(1 / 1.2);
    else if (e.key === "0") fit();
    else return;
    e.preventDefault();
  };

  // Paint order: column by column, top to bottom — also the tab order.
  const ordered = useMemo(
    () =>
      [...graph.jobs].sort((a, b) => {
        const pa = positions.get(a.name)!;
        const pb = positions.get(b.name)!;
        return pa.level - pb.level || pa.order - pb.order;
      }),
    [graph.jobs, positions],
  );
  const edgeIndex = useMemo(
    () => new Map(layout.edges.map((e) => [`${e.from}\u0000${e.to}`, e])),
    [layout],
  );

  if (graph.jobs.length === 0) {
    return (
      <div className="rg rg-empty">
        <div className="empty-state">
          <strong>This run has no jobs</strong>
        </div>
      </div>
    );
  }

  return (
    <div className="rg" onKeyDown={onGraphKeyDown}>
      <div
        ref={viewportRef}
        className="rg-viewport"
        style={{ height }}
        role="group"
        aria-label="Job graph"
        aria-describedby={hintId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={(e) => {
          if (!swallowClick.current) return;
          swallowClick.current = false;
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          // A click on empty canvas closes the job panel.
          const target = asDom(e.target);
          if (selected && !target.closest(".rg-node, .rg-controls")) {
            onSelect(null);
          }
        }}
      >
        <div
          className="rg-world"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          }}
        >
          <svg
            className="rg-edges"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            aria-hidden="true"
          >
            {graph.edges.map((e) => {
              const routed = edgeIndex.get(`${e.from}\u0000${e.to}`);
              if (!routed) return null;
              const d = edgePath(routed.points);
              const start = routed.points[0];
              const end = routed.points[routed.points.length - 1];
              const cls = [
                "rg-edge",
                `rg-edge-${e.state}`,
                e.active ? "is-active" : "",
                routed.reversed ? "is-cycle" : "",
                related ? (edgeLit(e) ? "is-lit" : "is-dim") : "",
              ].filter(Boolean).join(" ");
              return (
                <g key={`${e.from}\u0000${e.to}`} className={cls}>
                  <title>
                    {`${e.from} → ${e.to}: runs when ${e.from} ${
                      describeCondition(e.condition)
                    }${e.state === "unmet" ? " (not met)" : ""}`}
                  </title>
                  <path className="rg-edge-line" d={d} />
                  {e.active && <path className="rg-edge-flow" d={d} />}
                  <circle
                    className="rg-edge-end"
                    cx={start.x}
                    cy={start.y}
                    r={3}
                  />
                  <circle className="rg-edge-end" cx={end.x} cy={end.y} r={3} />
                </g>
              );
            })}
          </svg>
          {ordered.map((job) => {
            const pos = positions.get(job.name)!;
            return (
              <JobNode
                key={job.name}
                job={job}
                x={pos.x}
                y={pos.y}
                now={now}
                selected={selected === job.name}
                dim={!lit(job.name)}
                hot={hot === job.name}
                tabbable={tabStop === job.name}
                onNavigate={onNavigate}
                buttonRef={(el) => {
                  if (el) nodeRefs.current.set(job.name, el);
                  else nodeRefs.current.delete(job.name);
                }}
                onSelect={() =>
                  onSelect(selected === job.name ? null : job.name)}
                onHover={(on) => setHovered(on ? job.name : null)}
                onFocusChange={(on) => {
                  if (on) {
                    setFocused(job.name);
                    reveal(job.name);
                  } else {
                    setFocused((f) => (f === job.name ? null : f));
                  }
                }}
                onKeyDown={(e) => onNodeKeyDown(e, job.name)}
              />
            );
          })}
        </div>
        <div
          className="rg-controls"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="rg-control"
            aria-label="Zoom out"
            title="Zoom out (−)"
            onClick={() => zoomAt(1 / 1.2)}
            disabled={view.k <= MIN_ZOOM}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M3 7h8"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <span className="rg-zoom" aria-live="polite">
            {Math.round(view.k * 100)}%
          </span>
          <button
            type="button"
            className="rg-control"
            aria-label="Zoom in"
            title="Zoom in (+)"
            onClick={() => zoomAt(1.2)}
            disabled={view.k >= MAX_ZOOM}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M3 7h8M7 3v8"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="rg-control rg-fit"
            title="Fit the whole graph (0)"
            onClick={fit}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M2 5V2h3M9 2h3v3M12 9v3H9M5 12H2V9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Fit
          </button>
        </div>
      </div>
      <div className="rg-footer">
        <span id={hintId} className="rg-hint">
          Drag to pan · ⌘/Ctrl + scroll or pinch to zoom · arrow keys move
          between jobs · Enter opens one
        </span>
        <EdgeLegend edges={graph.edges} />
        {!graph.hasDependencies && (
          <span className="rg-note">
            Dependencies unavailable — jobs shown in run order
          </span>
        )}
      </div>
    </div>
  );
}

function EdgeLegend({ edges }: { edges: RunGraphEdge[] }) {
  const unmet = edges.some((e) => e.state === "unmet");
  if (!unmet) return null;
  return (
    <span className="rg-legend">
      <svg width="22" height="6" aria-hidden="true">
        <path d="M1 3h20" className="rg-legend-unmet" />
      </svg>
      condition not met
    </span>
  );
}

interface JobNodeProps {
  job: RunGraphJob;
  x: number;
  y: number;
  now: number;
  selected: boolean;
  dim: boolean;
  hot: boolean;
  tabbable: boolean;
  onNavigate: (to: RouteState) => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onHover: (on: boolean) => void;
  onFocusChange: (on: boolean) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

function JobNode(props: JobNodeProps) {
  const { job, now } = props;
  const live = isLive(job.status);
  const duration = elapsed(job, now, live);
  const summary = job.status === "failed" && job.failedStep
    ? `${job.failedStep.name} failed`
    : jobSummary(job);
  const time = duration !== undefined ? formatDuration(duration) : null;
  const progress = job.status === "running" && job.stepsTotal > 0
    ? job.stepsDone / job.stepsTotal
    : null;
  const nested = job.nested[0];
  const cls = [
    "rg-node",
    `rg-${job.status}`,
    props.selected ? "is-selected" : "",
    props.dim ? "is-dim" : "",
    props.hot ? "is-hot" : "",
    nested ? "has-nested" : "",
  ].filter(Boolean).join(" ");
  const label = [
    job.name,
    statusLabel(job.status),
    summary !== statusLabel(job.status) ? summary : null,
    time,
  ].filter(Boolean).join(", ");

  return (
    <div
      className={cls}
      style={{
        left: props.x,
        top: props.y,
        width: DEFAULT_LAYOUT.nodeWidth,
        height: DEFAULT_LAYOUT.nodeHeight,
      }}
      onPointerEnter={() => props.onHover(true)}
      onPointerLeave={() => props.onHover(false)}
    >
      <button
        type="button"
        ref={props.buttonRef}
        className="rg-node-main"
        tabIndex={props.tabbable ? 0 : -1}
        aria-pressed={props.selected}
        aria-label={label}
        title={job.failedStep?.error
          ? `${job.name}\n${job.failedStep.name}: ${job.failedStep.error}`
          : job.name}
        onClick={props.onSelect}
        onKeyDown={props.onKeyDown}
        onFocus={() => props.onFocusChange(true)}
        onBlur={() => props.onFocusChange(false)}
      >
        <RunStatusIcon status={job.status} size={18} label="" />
        <span className="rg-node-text">
          <span className="rg-node-name">{job.name}</span>
          <span className="rg-node-meta">
            <span className="rg-node-summary">{summary}</span>
            {time && <span className="rg-node-time mono">{time}</span>}
          </span>
        </span>
      </button>
      {nested && (
        <NestedLink
          workflowName={nested.workflowName}
          runId={nested.runId}
          more={job.nested.length - 1}
          onNavigate={props.onNavigate}
        />
      )}
      {progress !== null && (
        <span className="rg-progress" aria-hidden="true">
          <span style={{ width: `${Math.max(4, progress * 100)}%` }} />
        </span>
      )}
    </div>
  );
}

function NestedLink(
  { workflowName, runId, more, onNavigate }: {
    workflowName: string;
    runId: string;
    more: number;
    onNavigate: (to: RouteState) => void;
  },
) {
  const to: RouteState = {
    view: "workflows",
    detail: { kind: "run", workflowName, runId },
  };
  return (
    <a
      className="rg-node-nested"
      href={buildPath(to)}
      tabIndex={-1}
      title={`Open the nested run of ${workflowName}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!isPlainLeftClick(e)) return;
        e.preventDefault();
        onNavigate(to);
      }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path
          d="M2 1v4.5a1.5 1.5 0 0 0 1.5 1.5H8M6 5l2 2-2 2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>{workflowName}</span>
      {more > 0 && <span className="rg-node-more">+{more}</span>}
    </a>
  );
}
