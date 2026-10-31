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
import type { AgentSessionToolCall } from "../../lib/agent_sessions/record.ts";
import {
  clampedDuration,
  type SpanNode,
  spanTree,
} from "../../lib/agent_session_view.ts";
import { formatDuration } from "../../lib/format.ts";

const LABEL_TEXT: Record<AgentSessionToolCall["label"], string> = {
  swamp: "swamp",
  bypass: "bypass",
  neutral: "neutral",
  unlabeled: "not classified",
};

function SpanList({ nodes }: { nodes: SpanNode[] }) {
  return (
    <ul>
      {nodes.map((node, i) => (
        <li
          key={`${node.name}-${i}`}
          className="as-span"
          data-error={node.error}
        >
          {node.name} · {formatDuration(node.duration)}
          {node.error && " · error"}
          {node.children.length > 0 && <SpanList nodes={node.children} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * One call: what it ran, how it was labelled and why, and its swamp spans.
 * It docks to the bottom of the window, full width, so the turns keep theirs.
 */
export function CallInspector(
  { call, subagentLabel, onClose }: {
    call: AgentSessionToolCall;
    /** For a subagent call: the child it started, as the page names it. */
    subagentLabel?: string;
    onClose: () => void;
  },
) {
  return (
    <section
      className="panel as-inspector"
      aria-label="Call inspector"
      aria-live="polite"
    >
      <header className="as-inspector-head">
        <h2>
          <span className="as-inspector-kicker">Inspector</span>
          <span className="as-inspector-tool">
            <span className={`as-dot as-l-${call.label}`} /> {call.tool}
          </span>
        </h2>
        <button
          type="button"
          className="as-link-button"
          title="Close (Esc)"
          aria-label="Close the inspector"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <div className="as-inspector-body">
        <div>
          <pre>{call.text || "—"}</pre>
          {call.truncated && (
            <p className="as-muted">
              Cut to 1000 characters when it was imported.
            </p>
          )}
        </div>
        <div>
          <dl>
            <dt>Tool</dt>
            <dd>{call.tool} ({call.toolKind})</dd>
            <dt>Label</dt>
            <dd>
              <span className={`as-dot as-l-${call.label}`} />
              {LABEL_TEXT[call.label]}
            </dd>
            {call.label === "unlabeled"
              ? (
                <>
                  <dt>Rule</dt>
                  <dd className="as-muted">Not classified yet</dd>
                </>
              )
              : (
                <>
                  <dt>Category</dt>
                  <dd>{call.category}</dd>
                  <dt>Rule</dt>
                  <dd>{call.rule}</dd>
                </>
              )}
            <dt>Result</dt>
            <dd className={call.ok ? undefined : "as-failed"}>
              {call.ok ? "ok" : "failed"}
              {call.exitCode !== undefined && ` (exit ${call.exitCode})`}
            </dd>
            <dt>Duration</dt>
            <dd>{formatDuration(clampedDuration(call.start, call.end))}</dd>
            {subagentLabel && (
              <>
                <dt>Subagent</dt>
                <dd>{subagentLabel}</dd>
              </>
            )}
          </dl>
          {call.swampSpans && call.swampSpans.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h2>swamp spans</h2>
              {call.swampSpans.map((root, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div className="as-muted">
                    Command {i + 1}, {formatDuration(root.offset)}{" "}
                    after the call started
                  </div>
                  <SpanList nodes={spanTree(root.spans)} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
