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

import { useId } from "react";
import { buildPath, isPlainLeftClick, type RouteState } from "../routes.ts";
import { navigateTo } from "../hooks/useRouter.ts";
import {
  type FlowNode,
  type FlowSpec,
  layoutFlow,
  truncate,
} from "./trigger_flow.ts";

const TITLE_CHARS = 24;
const LINE_CHARS = 28;

const KIND_LABEL: Record<FlowNode["kind"], string> = {
  trigger: "Trigger",
  inputs: "Inputs",
  workflow: "Workflow",
  job: "Job",
};

function NodeBody({ node }: { node: FlowNode }) {
  return (
    <>
      <title>
        {`${KIND_LABEL[node.kind]}: ${node.title}${
          node.lines.length ? `\n${node.lines.join("\n")}` : ""
        }`}
      </title>
      <rect
        className="flow-node-box"
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={8}
      />
      <rect
        className="flow-node-accent"
        x={node.x}
        y={node.y + 8}
        width={3}
        height={node.h - 16}
        rx={1.5}
      />
      <text className="flow-node-kind" x={node.x + 14} y={node.y + 15}>
        {KIND_LABEL[node.kind].toUpperCase()}
      </text>
      <text className="flow-node-title" x={node.x + 14} y={node.y + 30}>
        {truncate(node.title, TITLE_CHARS)}
      </text>
      {node.lines.map((line, i) => (
        <text
          key={i}
          className="flow-node-line"
          x={node.x + 14}
          y={node.y + 50 + i * 16}
        >
          {truncate(line, LINE_CHARS)}
        </text>
      ))}
    </>
  );
}

/**
 * What a trigger starts: the schedule or webhook, the inputs it passes,
 * the workflow and its jobs in dependency order. The workflow node links
 * to the workflow's page.
 */
export function TriggerFlow({ spec }: { spec: FlowSpec }) {
  const markerId = `flow-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const layout = layoutFlow(spec);
  const workflowRoute: RouteState = {
    view: "workflows",
    detail: { kind: "workflow", workflowName: spec.workflowName },
  };
  const label = `${spec.trigger.title} starts ${spec.workflowName}${
    spec.jobs.length
      ? `, which runs ${spec.jobs.map((j) => j.name).join(", ")}`
      : ""
  }`;

  return (
    <div className="trigger-flow">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        // Shrinks to fit a narrow panel down to 70%, then scrolls.
        style={{
          width: "100%",
          maxWidth: layout.width,
          minWidth: Math.round(layout.width * 0.7),
        }}
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 8 8"
            refX={7}
            refY={4}
            markerWidth={7}
            markerHeight={7}
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 z" className="flow-arrow" />
          </marker>
        </defs>
        {layout.edges.map((e) => (
          <path
            key={`${e.from}->${e.to}`}
            d={e.path}
            className={`flow-edge${e.dashed ? " dashed" : ""}`}
            markerEnd={`url(#${markerId})`}
          />
        ))}
        {layout.nodes.map((node) => {
          const cls = `flow-node kind-${node.kind}${
            node.muted ? " muted" : ""
          }`;
          if (node.kind === "workflow") {
            return (
              <a
                key={node.id}
                className={cls}
                href={buildPath(workflowRoute)}
                aria-label={`Open workflow ${node.title}`}
                onClick={(e) => {
                  if (!isPlainLeftClick(e)) return;
                  e.preventDefault();
                  navigateTo(workflowRoute);
                }}
              >
                <NodeBody node={node} />
              </a>
            );
          }
          return (
            <g key={node.id} className={cls}>
              <NodeBody node={node} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
