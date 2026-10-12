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

// One click from a failed run to its failure: the run page opens the
// failed step's log when the URL carries ?focus=failure.

import type { MouseEvent } from "react";
import { buildPath, isPlainLeftClick, type RouteState } from "../routes.ts";
import { navigateTo } from "../hooks/useRouter.ts";

export const FAILURE_FOCUS_PARAM = "focus";
export const FAILURE_FOCUS_VALUE = "failure";

function runRoute(workflowName: string, runId: string): RouteState {
  return {
    view: "workflows",
    detail: { kind: "run", workflowName, runId },
  };
}

/** `/dashboard/workflows/<wf>/runs/<run>?focus=failure`. */
export function failureHref(workflowName: string, runId: string): string {
  return `${
    buildPath(runRoute(workflowName, runId))
  }?${FAILURE_FOCUS_PARAM}=${FAILURE_FOCUS_VALUE}`;
}

/**
 * Click handler for a link to `failureHref`: a plain left click navigates
 * in-app and then adds the focus param to the entry it pushed; modified
 * and middle clicks fall through to the browser (new tab, copy link).
 * Stops propagation so a link inside a clickable card or row opens the
 * failure, not the container.
 */
export function openFailureOnClick(
  workflowName: string,
  runId: string,
): (e: MouseEvent<HTMLAnchorElement>) => void {
  return (e) => {
    e.stopPropagation();
    if (!isPlainLeftClick(e)) return;
    e.preventDefault();
    navigateTo(runRoute(workflowName, runId));
    try {
      history.replaceState(
        history.state,
        "",
        failureHref(workflowName, runId),
      );
    } catch {
      // No history API: the run opens without the focus hint.
    }
  };
}

/** A small danger-toned "View failure" link to a failed run's log. */
export function FailureLink(
  { workflowName, runId, label = "View failure" }: {
    workflowName: string;
    runId: string;
    label?: string;
  },
) {
  return (
    <a
      className="failure-link"
      href={failureHref(workflowName, runId)}
      title={`Open the failed step's log (run ${runId.slice(0, 8)})`}
      onClick={openFailureOnClick(workflowName, runId)}
    >
      {label}
    </a>
  );
}
