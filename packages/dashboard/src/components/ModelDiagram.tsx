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
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useId,
  useState,
} from "react";
import { buildPath, isPlainLeftClick, type RouteState } from "../routes.ts";
import {
  type DiagramGroupKey,
  type DiagramLayout,
  type DiagramNodeKind,
  type DiagramOrientation,
  type DiagramSpec,
  frameLabel,
  layoutDiagram,
  type PlacedBox,
  type PlacedToggle,
} from "./model_diagram_layout.ts";
import { describeDiagram } from "./model_diagram_spec.ts";

// The model diagram: inputs → model → outputs and reports. Both
// orientations render; a container query shows the horizontal one when
// there is room and the vertical one otherwise, so the choice needs no
// measuring and server rendering matches the browser.

const GROUP_NOUN: Record<DiagramGroupKey, string> = {
  arguments: "Argument",
  methods: "Method",
  outputs: "Output",
  reports: "Report",
};

const KIND_LABEL: Record<DiagramNodeKind, string> = {
  argument: "Argument",
  method: "Method",
  resource: "Resource",
  file: "File",
  data: "Data",
  report: "Report",
  placeholder: "",
};

/** A 12×12 glyph per kind, drawn in currentColor. */
function Glyph({ kind }: { kind: DiagramNodeKind }) {
  switch (kind) {
    case "argument":
      return (
        <path d="M4 1.5C2.5 1.5 2.5 3 2.5 4.5S1 6 1 6s1.5 0 1.5 1.5S2.5 10.5 4 10.5M8 1.5c1.5 0 1.5 1.5 1.5 3S11 6 11 6s-1.5 0-1.5 1.5 0 3-1.5 3" />
      );
    case "method":
      return (
        <path d="M8.5 1.5C6.5 1.5 6 2.5 5.7 4.5L4.6 9C4.3 10.3 3.8 10.5 2.5 10.5M3.5 5h5" />
      );
    case "resource":
      return (
        <path d="M6 1 10.5 3.5v5L6 11 1.5 8.5v-5L6 1Zm0 0v0M1.5 3.5 6 6l4.5-2.5M6 6v5" />
      );
    case "file":
      return <path d="M2.5 1h4.5l2.5 2.5V11h-7V1Zm4.5 0v2.5h2.5" />;
    case "data":
      return (
        <path d="M1.5 3c0-1.1 2-2 4.5-2s4.5.9 4.5 2-2 2-4.5 2-4.5-.9-4.5-2Zm0 0v6c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V3M1.5 6c0 1.1 2 2 4.5 2s4.5-.9 4.5-2" />
      );
    case "report":
      return <path d="M1.5 11h9M3 9V6M6 9V2.5M9 9V4.5" />;
    case "placeholder":
      return <circle cx="6" cy="6" r="3.5" strokeDasharray="2 2" />;
  }
}

/** In-app navigation for a link; without one, links load like plain hrefs. */
export type Navigate = (to: RouteState) => void;

function go(e: MouseEvent, to: RouteState, navigate: Navigate | undefined) {
  if (!navigate || !isPlainLeftClick(e)) return;
  e.preventDefault();
  navigate(to);
}

function boxTitle(box: PlacedBox): string {
  const lines = [box.node.label];
  if (box.node.detail) lines.push(box.node.detail);
  if (box.node.description) lines.push(box.node.description);
  return lines.join("\n");
}

function BoxNode(
  { box, active, onHover, navigate }: {
    box: PlacedBox;
    active: string | null;
    onHover: (id: string | null) => void;
    navigate?: Navigate;
  },
) {
  const edgeId = `${box.side}:${box.group}:${box.node.id}`;
  const kind = box.node.kind;
  const body = (
    <>
      <title>{boxTitle(box)}</title>
      <rect className="md-box" width={box.w} height={box.h} rx={8} />
      <g
        className="md-glyph"
        transform="translate(12 9)"
        fill="none"
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <Glyph kind={kind} />
      </g>
      <text className="md-label" x={32} y={kind === "placeholder" ? 26 : 19}>
        {box.label}
      </text>
      {box.detail && kind !== "placeholder" && (
        <text className="md-detail" x={32} y={34}>{box.detail}</text>
      )}
    </>
  );
  const className = `md-node md-group-${box.group} md-kind-${kind}${
    active === edgeId ? " is-active" : ""
  }`;
  const hover = {
    onMouseEnter: () => onHover(edgeId),
    onMouseLeave: () => onHover(null),
    onFocus: () => onHover(edgeId),
    onBlur: () => onHover(null),
  };
  const transform = `translate(${box.x} ${box.y})`;
  const to = box.node.to;
  if (to) {
    const aria = [
      `${GROUP_NOUN[box.group]} ${box.node.label}`,
      box.node.detail,
    ].filter(Boolean).join(", ");
    // React types <a> as the HTML element, so the SVG link takes its
    // position from a wrapping group.
    return (
      <g transform={transform}>
        <a
          href={buildPath(to)}
          className={`${className} md-link`}
          aria-label={aria}
          onClick={(e) => go(e, to, navigate)}
          {...hover}
        >
          {body}
        </a>
      </g>
    );
  }
  return (
    <g className={className} transform={transform} {...hover}>
      {body}
    </g>
  );
}

function ToggleNode(
  { toggle, onToggle }: {
    toggle: PlacedToggle;
    onToggle: (group: DiagramGroupKey) => void;
  },
) {
  const noun = GROUP_NOUN[toggle.group].toLowerCase();
  const onKeyDown = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle(toggle.group);
    }
  };
  return (
    <g
      className="md-toggle"
      role="button"
      tabIndex={0}
      aria-expanded={toggle.expanded}
      aria-label={toggle.expanded
        ? `Show fewer ${noun}s`
        : `Show ${toggle.hidden} more ${noun}${toggle.hidden === 1 ? "" : "s"}`}
      transform={`translate(${toggle.x} ${toggle.y})`}
      onClick={() => onToggle(toggle.group)}
      onKeyDown={onKeyDown}
    >
      <rect width={toggle.w} height={toggle.h} rx={8} />
      <text x={toggle.w / 2} y={toggle.h / 2 + 4} textAnchor="middle">
        {toggle.label}
      </text>
    </g>
  );
}

function chipWidth(text: string): number {
  return Math.round(text.length * 6.2 + 14);
}

function ModelCard(
  { spec, layout }: { spec: DiagramSpec; layout: DiagramLayout },
) {
  const m = layout.model;
  const chips: Array<{ text: string; tone: string; title?: string }> = [];
  if (spec.model.version !== undefined) {
    chips.push({ text: `v${spec.model.version}`, tone: "neutral" });
  }
  if (spec.model.stale) {
    chips.push({
      text: spec.model.stale,
      tone: "warning",
      title: "The definition's type version is not current",
    });
  }
  let cx = 18;
  return (
    <g className="md-model" transform={`translate(${m.x} ${m.y})`}>
      <title>{`${spec.model.name}\n${spec.model.type}`}</title>
      <rect className="md-model-box" width={m.w} height={m.h} rx={12} />
      <rect
        className="md-model-band"
        width={4}
        height={m.h - 28}
        x={0}
        y={14}
        rx={2}
      />
      <text className="md-model-type" x={18} y={28}>{m.type}</text>
      <text className="md-model-name" x={18} y={54}>{m.name}</text>
      <g transform={`translate(0 ${m.h - 32})`}>
        {chips.map((c) => {
          const w = chipWidth(c.text);
          const x = cx;
          cx += w + 6;
          return (
            <g
              key={c.text}
              className={`md-chip tone-${c.tone}`}
              transform={`translate(${x} 0)`}
            >
              {c.title && <title>{c.title}</title>}
              <rect width={w} height={18} rx={4} />
              <text x={w / 2} y={12.5} textAnchor="middle">{c.text}</text>
            </g>
          );
        })}
        {spec.model.summary && (
          <text className="md-model-summary" x={cx + 2} y={12.5}>
            {spec.model.summary}
          </text>
        )}
      </g>
    </g>
  );
}

function Frame(
  { spec, layout, navigate }: {
    spec: DiagramSpec;
    layout: DiagramLayout;
    navigate?: Navigate;
  },
) {
  const f = layout.frame;
  const ext = spec.extension;
  if (!f || !ext) return null;
  const content = (
    <>
      <title>
        {ext.inferred
          ? `${ext.name}\nInferred from the model type; serve did not report an extension`
          : frameLabel(ext)}
      </title>
      <rect
        className="md-frame-box"
        x={f.x}
        y={f.y}
        width={f.w}
        height={f.h}
        rx={16}
      />
      <g
        className="md-frame-glyph"
        transform={`translate(${f.x + 12} ${f.y + 8})`}
        fill="none"
        strokeWidth={1.3}
        strokeLinejoin="round"
      >
        <path d="M1.5 3.5h3V3a1.5 1.5 0 0 1 3 0v.5h3v3h-.5a1.5 1.5 0 0 0 0 3h.5v2h-9v-8Z" />
      </g>
      <text className="md-frame-label" x={f.labelX} y={f.labelY}>
        {f.label}
      </text>
    </>
  );
  const cls = `md-frame${ext.inferred ? " is-inferred" : ""}`;
  if (ext.inferred) return <g className={cls}>{content}</g>;
  const to: RouteState = { view: "extensions", detail: null };
  return (
    <a
      className={`${cls} md-link`}
      href={buildPath(to)}
      aria-label={`Extension ${frameLabel(ext)}`}
      onClick={(e) => go(e, to, navigate)}
    >
      {content}
    </a>
  );
}

function DiagramSvg(
  { spec, orientation, expanded, onToggle, describedBy, navigate }: {
    spec: DiagramSpec;
    navigate?: Navigate;
    orientation: DiagramOrientation;
    expanded: ReadonlySet<DiagramGroupKey>;
    onToggle: (group: DiagramGroupKey) => void;
    describedBy: string;
  },
) {
  const [active, setActive] = useState<string | null>(null);
  const layout = layoutDiagram(spec, { orientation, expanded });
  const headings: ReactNode[] = layout.headings.map((h) => (
    <text
      key={`h-${h.group}`}
      className={`md-heading md-group-${h.group}`}
      x={h.x}
      y={h.y}
    >
      {h.text.toUpperCase()}
      {h.count > 0 && (
        <tspan className="md-heading-count">{` ${h.count}`}</tspan>
      )}
    </text>
  ));
  return (
    <svg
      className={`md-svg md-${orientation === "horizontal" ? "h" : "v"}${
        active ? " has-active" : ""
      }`}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      height={layout.height}
      style={{ maxWidth: layout.width }}
      role="group"
      aria-label={`Diagram of model ${spec.model.name}`}
      aria-describedby={describedBy}
      data-orientation={orientation}
    >
      <g className="md-edges" aria-hidden="true">
        {layout.edges.map((e) => (
          <path
            key={e.id}
            d={e.d}
            className={`md-edge md-group-${e.group}${
              e.muted ? " is-muted" : ""
            }${active === e.id ? " is-active" : ""}`}
          />
        ))}
      </g>
      <Frame spec={spec} layout={layout} navigate={navigate} />
      <ModelCard spec={spec} layout={layout} />
      {headings}
      {layout.boxes.map((b) => (
        <BoxNode
          key={`${b.group}:${b.node.id}`}
          box={b}
          active={active}
          onHover={setActive}
          navigate={navigate}
        />
      ))}
      {layout.toggles.map((t) => (
        <ToggleNode key={`t-${t.group}`} toggle={t} onToggle={onToggle} />
      ))}
    </svg>
  );
}

/** The kinds a diagram uses, for its legend. */
function legendKinds(spec: DiagramSpec): DiagramNodeKind[] {
  const order: DiagramNodeKind[] = [
    "argument",
    "method",
    "resource",
    "file",
    "data",
    "report",
  ];
  const used = new Set(spec.groups.flatMap((g) => g.nodes.map((n) => n.kind)));
  return order.filter((k) => used.has(k));
}

export function ModelDiagram(
  { spec, onNavigate }: { spec: DiagramSpec; onNavigate?: Navigate },
) {
  const [expanded, setExpanded] = useState<ReadonlySet<DiagramGroupKey>>(
    () => new Set(),
  );
  const descId = useId();
  const toggle = (group: DiagramGroupKey) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };
  return (
    <div className="model-diagram">
      <p id={descId} className="visually-hidden">{describeDiagram(spec)}</p>
      <div className="md-canvas">
        {(["horizontal", "vertical"] as const).map((o) => (
          <DiagramSvg
            key={o}
            spec={spec}
            orientation={o}
            expanded={expanded}
            onToggle={toggle}
            describedBy={descId}
            navigate={onNavigate}
          />
        ))}
      </div>
      <ul className="md-legend" aria-label="Legend">
        {legendKinds(spec).map((k) => (
          <li key={k} className={`md-kind-${k}`}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.3}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <Glyph kind={k} />
            </svg>
            {KIND_LABEL[k]}
          </li>
        ))}
      </ul>
    </div>
  );
}
