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
import { useEffect, useMemo, useRef } from "react";
import { useRequest } from "../client/useRequest.ts";
import { extractObject } from "../client/extract.ts";
import { buildPath, isPlainLeftClick } from "../routes.ts";
import type { DataItem } from "../views/data_target.ts";
import type { DrawerItem } from "../views/run_item_param.ts";
import { Skeleton, SkeletonRegion } from "./Skeleton.tsx";
import { logFromOutputs, parseLog, pickLogArtifact } from "./step_log.ts";
import type { ArtifactRefLike } from "./run_graph_model.ts";

/**
 * A step's own log — the `file` item its model wrote (stdout and stderr
 * for a shell command) — tail first, scrolled to the end where a failure's
 * reason usually is. Falls back to captured stdout/stderr outputs.
 */
export function StepLog(
  { artifacts, outputs, failed, onOpenItem }: {
    artifacts?: ArtifactRefLike[];
    outputs?: Record<string, unknown>;
    failed: boolean;
    onOpenItem: (item: DrawerItem) => void;
  },
) {
  const ref = pickLogArtifact(artifacts);
  const modelName = ref?.tags?.modelName;
  const req = useRequest("data.get", {
    modelIdOrName: modelName,
    dataName: ref?.name,
    version: ref?.version,
    includeContent: true,
  }, { enabled: ref !== null && !!modelName });
  const item = req.error ? null : extractObject<DataItem>(req.data);
  const binary = item?.contentEncoding === "base64";
  const text = item && !binary
    ? item.content ?? ""
    : ref === null
    ? logFromOutputs(outputs)
    : null;
  const parsed = useMemo(() => (text !== null ? parseLog(text) : null), [
    text,
  ]);

  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [parsed]);

  const target: DrawerItem | null = ref && modelName
    ? { kind: "data", modelName, dataName: ref.name, version: ref.version }
    : null;
  const open = target
    ? (
      <a
        className="sl-open"
        href={buildPath({ view: "models", detail: target })}
        onClick={(e) => {
          if (!isPlainLeftClick(e)) return;
          e.preventDefault();
          onOpenItem(target);
        }}
      >
        Open log
      </a>
    )
    : null;

  if (ref && req.loading && !item) {
    return (
      <SkeletonRegion label="Loading step log" className="sl sl-loading">
        {[70, 52, 64].map((w, i) => (
          <Skeleton key={i} width={`${w}%`} height={10} />
        ))}
      </SkeletonRegion>
    );
  }
  if (ref && req.error) {
    return (
      <div className="sl sl-empty">
        The step's log could not be loaded ({req.error}).{" "}
        <button type="button" className="btn-sm" onClick={req.refetch}>
          Retry
        </button>
      </div>
    );
  }
  if (binary) {
    return <div className="sl sl-empty">The log is binary. {open}</div>;
  }
  if (!parsed || parsed.lines.length === 0) {
    return (
      <div className="sl sl-empty">
        {ref ? "The log is empty." : "No log was captured for this step."}
        {open && <>{open}</>}
      </div>
    );
  }
  return (
    <div className={`sl${failed ? " is-failed" : ""}`}>
      <div className="sl-head">
        <span className="sl-title">Log</span>
        <span className="sl-count">
          {parsed.truncated > 0
            ? `last ${parsed.lines.length} of ${
              parsed.lines.length + parsed.truncated
            } lines`
            : `${parsed.lines.length} ${
              parsed.lines.length === 1 ? "line" : "lines"
            }`}
        </span>
        {open}
      </div>
      <pre
        ref={preRef}
        className="sl-lines"
        tabIndex={0}
        aria-label="Step log"
      >
        {parsed.lines.map((line, i) => (
          <span
            key={i}
            className={`sl-line${line.stream ? ` sl-${line.stream}` : ""}`}
          >
            {line.text || " "}
          </span>
        ))}
      </pre>
    </div>
  );
}
