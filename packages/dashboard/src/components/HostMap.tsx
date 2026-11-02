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
import { type KeyboardEvent, useEffect, useRef } from "react";
import { select, type Selection } from "d3-selection";
import "d3-transition";
import { easeCubicIn, easeCubicInOut, easeCubicOut } from "d3-ease";
import {
  forceCollide,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";
import {
  fadeFraction,
  type FleetWorker,
  groupCaption,
  type GroupStats,
  groupValue,
  groupWorkers,
  hostMapDrawMode,
  isEligible,
  isEmptySelector,
  type Selector,
  type Slot,
  toSchedulable,
  type WorkerStatus,
} from "../lib/host_map_model.ts";
import {
  clampBounds,
  type GroupCell,
  HEADER,
  layoutGroups,
  nodeSize,
  slotGrid,
} from "../lib/host_map_layout.ts";
import { resizeObserverClass } from "./dom_types.ts";

export interface HostMapProps {
  /** Workers to draw, already filtered by status and the visibility TTL. */
  workers: readonly FleetWorker[];
  /** Slot state per worker name. */
  slots: ReadonlyMap<string, readonly Slot[]>;
  /** Label key (or `platform`) to group by. */
  groupBy: string;
  ttlMs: number;
  /** When set and non-empty, workers it would not place on are dimmed. */
  selector?: Selector;
  selectedName: string | null;
  onSelect: (name: string | null) => void;
  /** Accessible name for the map. */
  label: string;
  /** The tab is hidden: draw nothing until it is back in view. */
  hidden?: boolean;
}

interface SimNode extends SimulationNodeDatum {
  name: string;
  size: number;
  worker: FleetWorker;
  group: string;
  gone?: boolean;
}

/** How long leaving workers take to shrink away before the layout moves. */
const EXIT_MS = 320;
/** How long cards and workers glide to a new layout. */
const GLIDE_MS = 700;
/** Simulation ticks run off-screen to find where workers come to rest. */
const SETTLE_TICKS = 260;
/** Golden angle, for sunflower seeding of a card's workers. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/**
 * A disconnected worker starts half faded, so it reads as gone rather than
 * failed, and fades by this much more over the visibility TTL — ending above
 * the placement selector's `.hm-dim` (host-map.css).
 */
const DISCONNECTED_OPACITY = 0.5;
const DISCONNECTED_FADE = 0.3;

const STATUS_ORDER: readonly WorkerStatus[] = [
  "unverified",
  "idle",
  "busy",
  "draining",
  "disconnected",
];

const STATUS_LABEL: Record<WorkerStatus, string> = {
  unverified: "Unverified",
  idle: "Idle",
  busy: "Busy",
  draining: "Draining",
  disconnected: "Disconnected",
};

function prefersReducedMotion(): boolean {
  const media = (globalThis as {
    matchMedia?: (query: string) => { matches: boolean };
  }).matchMedia;
  return media?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** A DOM id per worker name, unique within one map (names may contain any character). */
function nodeDomId(
  st: { prefix: string; ids: Map<string, string> },
  name: string,
): string {
  let id = st.ids.get(name);
  if (id === undefined) {
    id = `${st.prefix}-${st.ids.size}`;
    st.ids.set(name, id);
  }
  return id;
}

/**
 * The fleet host map. React owns the frame; D3 owns the SVG inside it: group
 * cards laid out as a capacity-weighted treemap, worker squares sized by
 * capacity with one cell per dispatch slot, and a force simulation that holds
 * each worker inside its card. All geometry and state come from the pure
 * `host_map_model` and `host_map_layout` modules.
 *
 * Styles live in `src/styles/host-map.css`, imported by the view.
 */
export function HostMap(props: HostMapProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const stateRef = useRef<{
    sim?: Simulation<SimNode, undefined>;
    nodes: Map<string, SimNode>;
    cells: Map<string, GroupCell>;
    width: number;
    active: number;
    order: string[];
    prefix: string;
    dataKey: string;
    /** Set while leaving workers finish exiting, before the layout moves. */
    exitTimer?: ReturnType<typeof setTimeout>;
    /** Set while workers glide to a settled layout; ticks must not move them. */
    glideTimer?: ReturnType<typeof setTimeout>;
    /** A draw was skipped while the tab was hidden. */
    skipped: boolean;
    initialized: boolean;
    ids: Map<string, string>;
  }>({
    nodes: new Map(),
    cells: new Map(),
    width: 0,
    active: 0,
    order: [],
    prefix: `hm${Math.random().toString(36).slice(2, 8)}`,
    dataKey: "",
    skipped: false,
    initialized: false,
    ids: new Map(),
  });
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const st = stateRef.current;
    const sim = forceSimulation<SimNode>([])
      .velocityDecay(0.32)
      .alphaTarget(prefersReducedMotion() ? 0 : 0.015)
      .force(
        "x",
        forceX<SimNode>((d) => st.cells.get(d.group)?.cx ?? 0).strength(0.12),
      )
      .force(
        "y",
        forceY<SimNode>((d) => st.cells.get(d.group)?.cy ?? 0).strength(0.12),
      )
      .force(
        "collide",
        forceCollide<SimNode>((d) => d.size * 0.7 + 1.5).strength(0.9),
      )
      .force("contain", () => {
        for (const d of sim.nodes()) {
          const cell = st.cells.get(d.group);
          if (!cell || d.x === undefined || d.y === undefined) continue;
          const b = clampBounds(cell, d.size);
          if (d.x < b.minX) [d.x, d.vx] = [b.minX, Math.max(0, d.vx ?? 0)];
          if (d.x > b.maxX) [d.x, d.vx] = [b.maxX, Math.min(0, d.vx ?? 0)];
          if (d.y < b.minY) [d.y, d.vy] = [b.minY, Math.max(0, d.vy ?? 0)];
          if (d.y > b.maxY) [d.y, d.vy] = [b.maxY, Math.min(0, d.vy ?? 0)];
        }
      })
      .on("tick", () => {
        if (!svgRef.current || stateRef.current.glideTimer !== undefined) {
          return;
        }
        select(svgRef.current).select<SVGGElement>("g.hm-nodes")
          .selectAll<SVGGElement, SimNode>("g.hm-node")
          .filter((d) => !d.gone)
          .attr(
            "transform",
            (d) =>
              `translate(${(d.x ?? 0).toFixed(1)},${(d.y ?? 0).toFixed(1)})`,
          );
      });
    st.sim = sim;
    const Observer = resizeObserverClass();
    const observer = Observer ? new Observer(() => draw(true)) : undefined;
    if (frameRef.current) observer?.observe(frameRef.current);
    return () => {
      observer?.disconnect();
      sim.stop();
      if (st.exitTimer !== undefined) clearTimeout(st.exitTimer);
      if (st.glideTimer !== undefined) clearTimeout(st.glideTimer);
    };
    // draw reads the latest props through propsRef, so this runs once.
  }, []);

  useEffect(() => {
    draw(false);
  });

  function draw(resized: boolean) {
    const svgEl = svgRef.current;
    const frame = frameRef.current;
    const st = stateRef.current;
    if (!svgEl || !frame || !st.sim) return;
    const p = propsRef.current;
    const mode = hostMapDrawMode({
      hidden: p.hidden === true,
      skipped: st.skipped,
    });
    if (mode === "skip") {
      pause(svgEl);
      return;
    }
    // While leaving workers exit, the old layout must stay installed: the
    // follow-up draw then sees the change and glides to it.
    if (st.exitTimer !== undefined) return;
    const reduced = prefersReducedMotion();
    // Back in view, the map goes straight to where it is now.
    const still = reduced || mode === "snap";
    st.skipped = false;
    const width = Math.max(
      320,
      (frame as unknown as { clientWidth: number }).clientWidth,
    );
    const widthChanged = width !== st.width;
    st.width = width;

    const groups: GroupStats[] = groupWorkers(p.workers, p.groupBy);
    const layout = layoutGroups(
      groups.map((g) => ({
        key: g.key,
        capacities: g.workers.map((w) => w.capacity),
      })),
      width,
    );
    const previousCells = st.cells;
    st.cells = new Map(layout.cells.map((c) => [c.key, c]));
    const regrouped = resized || widthChanged ||
      layout.cells.some((c) => {
        const prev = previousCells.get(c.key);
        return !prev || prev.x !== c.x || prev.y !== c.y || prev.w !== c.w ||
          prev.h !== c.h;
      });

    // Leaving workers shrink away where they stand first; only then do the
    // cards re-flow and the remaining workers move. Otherwise a leaving
    // worker fades at a spot its card has already moved away from.
    if (!still) {
      const staying = new Set(p.workers.map((w) => w.name));
      const leaving = [...st.nodes.keys()].filter((name) => !staying.has(name));
      if (leaving.length > 0) {
        st.cells = previousCells;
        exitNodes(new Set(leaving));
        st.exitTimer = setTimeout(() => {
          st.exitTimer = undefined;
          draw(false);
        }, EXIT_MS);
        return;
      }
    }

    const svg = select(svgEl)
      .attr("viewBox", `0 0 ${width} ${layout.height}`)
      .attr("height", layout.height);
    const duration = still ? 0 : GLIDE_MS;

    drawCells(svg, layout.cells, groups, duration);

    // Reuse simulation nodes so positions survive refreshes and regrouping.
    // New workers are seeded on a sunflower spiral round their card's centre,
    // outside the workers already there, so they start nearly unoverlapped.
    const nextNodes: SimNode[] = [];
    const seeded = new Map<string, number>();
    for (const node of st.nodes.values()) {
      seeded.set(node.group, (seeded.get(node.group) ?? 0) + 1);
    }
    for (const worker of p.workers) {
      const group = groupValue(worker, p.groupBy);
      let node = st.nodes.get(worker.name);
      if (!node) {
        const cell = st.cells.get(group);
        const index = seeded.get(group) ?? 0;
        seeded.set(group, index + 1);
        const angle = index * GOLDEN_ANGLE;
        const radius = (nodeSize(worker.capacity) + 4) * 0.62 *
          Math.sqrt(index + 0.5);
        node = {
          name: worker.name,
          size: nodeSize(worker.capacity),
          worker,
          group,
          x: (cell?.cx ?? 0) + Math.cos(angle) * radius,
          y: (cell?.cy ?? 0) + Math.sin(angle) * radius,
        };
        st.nodes.set(worker.name, node);
      }
      node.worker = worker;
      node.group = group;
      node.size = nodeSize(worker.capacity);
      node.gone = false;
      nextNodes.push(node);
    }
    const keep = new Set(nextNodes.map((n) => n.name));
    for (const name of [...st.nodes.keys()]) {
      if (!keep.has(name)) st.nodes.delete(name);
    }

    drawNodes(svg, nextNodes, p, duration);

    st.order = nextNodes
      .slice()
      .sort((a, b) =>
        a.group.localeCompare(b.group) || a.name.localeCompare(b.name)
      )
      .map((n) => n.name);
    if (st.active >= st.order.length) {
      st.active = Math.max(0, st.order.length - 1);
    }
    const activeName = st.order[st.active];
    svg.attr(
      "aria-activedescendant",
      activeName ? nodeDomId(st, activeName) : null,
    );

    // The view re-renders on a clock tick; reheat only when the data moved.
    const dataKey = `${p.groupBy}|` +
      nextNodes.map((n) => `${n.name}:${n.group}:${n.size}:${n.worker.status}`)
        .join(",");
    const dataChanged = dataKey !== st.dataKey;
    st.dataKey = dataKey;
    if (!dataChanged && !regrouped && !still) return;

    st.sim.nodes(nextNodes);
    if (still || !st.initialized) {
      // First paint (and reduced motion, and back in view): come to rest
      // off-screen, then draw workers where they settled, with no visible
      // shuffle.
      settle();
      st.initialized = true;
      if (reduced) {
        st.sim.stop();
      } else {
        st.sim.alpha(0.02).restart();
      }
    } else if (regrouped) {
      glide();
    } else {
      st.sim.alpha(Math.max(st.sim.alpha(), 0.05)).restart();
    }
  }

  /**
   * Stops all motion while the tab is hidden. Animation frames are paused
   * there, so transitions scheduled now would pile up unstarted for as long
   * as the tab stays hidden; the next visible draw snaps instead.
   */
  function pause(svgEl: SVGSVGElement) {
    const st = stateRef.current;
    if (st.skipped) return;
    st.skipped = true;
    st.sim?.stop();
    if (st.exitTimer !== undefined) clearTimeout(st.exitTimer);
    if (st.glideTimer !== undefined) clearTimeout(st.glideTimer);
    st.exitTimer = undefined;
    st.glideTimer = undefined;
    select(svgEl).selectAll("*").interrupt().interrupt("glide");
  }

  function settle() {
    const st = stateRef.current;
    if (!st.sim || !svgRef.current) return;
    st.sim.stop();
    st.sim.alpha(1);
    for (let i = 0; i < SETTLE_TICKS; i++) st.sim.tick();
    select(svgRef.current).select<SVGGElement>("g.hm-nodes")
      .selectAll<SVGGElement, SimNode>("g.hm-node")
      .filter((d) => !d.gone)
      .attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
  }

  /**
   * Moves cards and workers to a new layout on one shared ease: where each
   * worker comes to rest is worked out off-screen first, then every worker
   * glides there while the cards resize, and the drift resumes on arrival.
   */
  function glide() {
    const st = stateRef.current;
    if (!st.sim || !svgRef.current) return;
    if (st.glideTimer !== undefined) clearTimeout(st.glideTimer);
    st.sim.stop();
    st.sim.alpha(1);
    for (let i = 0; i < SETTLE_TICKS; i++) st.sim.tick();
    for (const node of st.sim.nodes()) {
      node.vx = 0;
      node.vy = 0;
    }
    st.glideTimer = setTimeout(() => {
      st.glideTimer = undefined;
      st.sim?.alpha(0.02).restart();
    }, GLIDE_MS + 20);
    select(svgRef.current).select<SVGGElement>("g.hm-nodes")
      .selectAll<SVGGElement, SimNode>("g.hm-node")
      .filter((d) => !d.gone)
      .transition("glide").duration(GLIDE_MS).ease(easeCubicInOut)
      .attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
  }

  function exitNodes(names: ReadonlySet<string>) {
    const st = stateRef.current;
    if (!svgRef.current || !st.sim) return;
    for (const name of names) st.nodes.delete(name);
    st.sim.nodes(st.sim.nodes().filter((n) => !names.has(n.name)));
    const leaving = select(svgRef.current).select<SVGGElement>("g.hm-nodes")
      .selectAll<SVGGElement, SimNode>("g.hm-node")
      .filter((d) => names.has(d.name))
      .each((d) => {
        d.gone = true;
      });
    leaving.select("g.hm-body").interrupt().transition().duration(EXIT_MS)
      .ease(easeCubicIn)
      .attr("transform", "scale(0)")
      .style("opacity", 0);
    leaving.transition().delay(EXIT_MS).remove();
  }

  function drawCells(
    svg: Selection<SVGSVGElement, unknown, null, undefined>,
    cells: readonly GroupCell[],
    groups: readonly GroupStats[],
    duration: number,
  ) {
    const statsByKey = new Map(groups.map((g) => [g.key, g]));
    const layer = svg.select<SVGGElement>("g.hm-cells");
    const join = layer.selectAll<SVGGElement, GroupCell>("g.hm-cell")
      .data(cells, (c) => c.key);

    const enter = join.enter().append("g")
      .attr("class", "hm-cell")
      .attr("transform", (c) => `translate(${c.x},${c.y})`)
      .style("opacity", 0);
    enter.append("rect").attr("class", "hm-cell-bg").attr("rx", 8);
    enter.append("text").attr("class", "hm-cell-name").attr("x", 14).attr(
      "y",
      20,
    );
    enter.append("text").attr("class", "hm-cell-count").attr("x", 14).attr(
      "y",
      35,
    );
    enter.append("g").attr("class", "hm-cell-bar").attr(
      "transform",
      `translate(14,${HEADER - 6})`,
    );

    const all = enter.merge(join);
    all.transition().duration(duration).ease(easeCubicInOut)
      .style("opacity", 1)
      .attr("transform", (c) => `translate(${c.x},${c.y})`);
    all.select<SVGRectElement>("rect.hm-cell-bg")
      .transition().duration(duration).ease(easeCubicInOut)
      .attr("width", (c) => c.w)
      .attr("height", (c) => c.h);
    all.select("text.hm-cell-name").text((c) => c.key);
    all.select("text.hm-cell-count").text((c) => {
      const g = statsByKey.get(c.key);
      return g ? groupCaption(g, c.w) : "";
    });
    all.each(function (c) {
      const g = statsByKey.get(c.key);
      const total = g?.workers.length ?? 0;
      const barW = Math.max(0, c.w - 28);
      let x = 0;
      const segs = STATUS_ORDER.map((s) => {
        const w = total ? (barW * (g?.byStatus[s] ?? 0)) / total : 0;
        const seg = { s, x, w };
        x += w;
        return seg;
      });
      const bars = select(this).select<SVGGElement>("g.hm-cell-bar")
        .selectAll<SVGRectElement, (typeof segs)[number]>("rect")
        .data(segs, (d) => d.s);
      bars.enter().append("rect")
        .attr("height", 2)
        .attr("class", (d) => `hm-bar hm-s-${d.s}`)
        .merge(bars)
        .transition().duration(duration)
        .attr("x", (d) => d.x)
        .attr("width", (d) => d.w);
    });

    join.exit().transition().duration(duration).style("opacity", 0).remove();
  }

  function drawNodes(
    svg: Selection<SVGSVGElement, unknown, null, undefined>,
    nodes: readonly SimNode[],
    p: HostMapProps,
    duration: number,
  ) {
    const st = stateRef.current;
    const filtering = p.selector !== undefined && !isEmptySelector(p.selector);
    const layer = svg.select<SVGGElement>("g.hm-nodes");
    const join = layer.selectAll<SVGGElement, SimNode>("g.hm-node")
      .data(nodes, (d) => d.name);

    const enter = join.enter().append("g")
      .attr("class", "hm-node")
      .attr("role", "img")
      .attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
      .on("click", (event: MouseEvent, d) => {
        event.stopPropagation();
        const current = propsRef.current;
        current.onSelect(current.selectedName === d.name ? null : d.name);
      });
    const body = enter.append("g").attr("class", "hm-body").attr(
      "transform",
      "scale(0)",
    );
    body.append("rect").attr("class", "hm-halo").attr("rx", 3);
    body.append("rect").attr("class", "hm-core").attr("rx", 3);
    body.append("g").attr("class", "hm-slots");
    body.append("rect").attr("class", "hm-ring").attr("rx", 5);
    enter.append("title");

    const all = enter.merge(join);
    // A worker that came back mid-exit is still bound to its element; cancel
    // the pending removal so the exit cannot take the returning worker.
    all.interrupt();
    all
      .attr("id", (d) => nodeDomId(st, d.name))
      .attr("class", (d) => {
        const dim = filtering &&
          !isEligible(p.selector!, toSchedulable(d.worker));
        return [
          "hm-node",
          `hm-s-${d.worker.status}`,
          p.selectedName === d.name ? "hm-selected" : "",
          st.order[st.active] === d.name ? "hm-active" : "",
          dim ? "hm-dim" : "",
        ].filter(Boolean).join(" ");
      })
      .attr("aria-label", (d) => {
        const used = d.worker.activeDispatchIds.length;
        return `${d.name}, ${STATUS_LABEL[d.worker.status]}, ` +
          `${used} of ${d.worker.capacity} slots leased, ${d.group}`;
      });
    all.select("title").text((d) =>
      `${d.name} · ${STATUS_LABEL[d.worker.status]} · ` +
      `${d.worker.activeDispatchIds.length}/${d.worker.capacity} slots`
    );

    const square = (
      sel: Selection<SVGRectElement, SimNode, SVGGElement, unknown>,
      pad: number,
    ) =>
      sel.attr("x", (d) => -d.size / 2 - pad)
        .attr("y", (d) => -d.size / 2 - pad)
        .attr("width", (d) => d.size + pad * 2)
        .attr("height", (d) => d.size + pad * 2);
    square(all.select<SVGRectElement>("rect.hm-halo"), 0);
    square(all.select<SVGRectElement>("rect.hm-core"), 0);
    square(all.select<SVGRectElement>("rect.hm-ring"), 3);

    all.select<SVGGElement>("g.hm-slots").each(function (d) {
      const slots = p.slots.get(d.name) ?? [];
      const cells = slotGrid(d.worker.capacity, d.size);
      const rects = select(this).selectAll<SVGRectElement, number>("rect")
        .data(cells.map((_, i) => i));
      rects.exit().remove();
      rects.enter().append("rect").attr("rx", 1)
        .merge(rects)
        .attr("x", (i) => cells[i].x)
        .attr("y", (i) => cells[i].y)
        .attr("width", (i) => cells[i].w)
        .attr("height", (i) => cells[i].h)
        .attr("class", (i) => `hm-slot hm-slot-${slots[i]?.state ?? "free"}`);
    });

    all.select<SVGGElement>("g.hm-body")
      .transition().duration(duration).ease(easeCubicOut)
      .attr("transform", (d) => {
        const f = fadeFraction(d.worker, Date.now(), p.ttlMs);
        const scale = d.worker.status === "disconnected"
          ? 1 - 0.55 * f
          : d.worker.status === "draining"
          ? 0.88
          : d.worker.status === "unverified"
          ? 0.82
          : 1;
        return `scale(${scale})`;
      })
      .style(
        "opacity",
        (d) =>
          d.worker.status === "disconnected"
            ? DISCONNECTED_OPACITY -
              DISCONNECTED_FADE *
                fadeFraction(d.worker, Date.now(), p.ttlMs)
            : 1,
      );

    const leaving = join.exit<SimNode>().each((d) => {
      d.gone = true;
    });
    leaving.select("g.hm-body").transition().duration(duration).ease(
      easeCubicIn,
    )
      .attr("transform", "scale(0)")
      .style("opacity", 0);
    leaving.transition().delay(duration).remove();
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const st = stateRef.current;
    if (st.order.length === 0) return;
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
    };
    if (event.key in step) {
      event.preventDefault();
      st.active = (st.active + step[event.key] + st.order.length) %
        st.order.length;
      draw(false);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      st.active = event.key === "Home" ? 0 : st.order.length - 1;
      draw(false);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const name = st.order[st.active];
      props.onSelect(props.selectedName === name ? null : name);
    } else if (event.key === "Escape") {
      props.onSelect(null);
    }
  }

  return (
    <div className="hm-frame" ref={frameRef}>
      <svg
        ref={svgRef}
        className="hm-svg"
        role="application"
        aria-roledescription="worker map"
        aria-label={props.label}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onClick={() => props.onSelect(null)}
      >
        <g className="hm-cells" />
        <g className="hm-nodes" />
      </svg>
    </div>
  );
}
