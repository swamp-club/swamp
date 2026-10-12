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
import { buildPath, isPlainLeftClick } from "../routes.ts";

/**
 * The run page with its failed step's log open: the run's path plus
 * `?focus=failure`, which the run page reads on load.
 */
export function failureHref(workflowName: string, runId: string): string {
  const path = buildPath({
    view: "workflows",
    detail: { kind: "run", workflowName, runId },
  });
  return `${path}?focus=failure`;
}

interface HistoryLike {
  pushState(data: unknown, unused: string, url: string): void;
}

/**
 * "View failure": one click from a failed run to its failure log. A real
 * link, so middle and modified clicks open it in a new tab; a plain click
 * navigates in-app and keeps the query the run page needs.
 */
export function FailureLink(
  { workflowName, runId, label = "View failure" }: {
    workflowName: string;
    runId: string;
    label?: string;
  },
) {
  const href = failureHref(workflowName, runId);
  return (
    <a
      className="failure-link"
      href={href}
      title={`Open the failed step's log of run ${runId.slice(0, 8)}`}
      onClick={(e) => {
        // Inside clickable rows: open the failure, not the row.
        e.stopPropagation();
        if (!isPlainLeftClick(e)) return;
        const history = (globalThis as { history?: HistoryLike }).history;
        if (!history) return;
        e.preventDefault();
        history.pushState(null, "", href);
        // The router follows the address bar on popstate.
        globalThis.dispatchEvent(new Event("popstate"));
      }}
    >
      {label}
    </a>
  );
}
