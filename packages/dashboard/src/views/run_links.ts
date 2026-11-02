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

import { buildPath } from "../routes.ts";
import { browserHistory } from "../components/dom_types.ts";

export const FOCUS_PARAM = "focus";
export const FOCUS_FAILURE = "failure";
export const STEP_PARAM = "step";

export function runHref(workflowName: string, runId: string): string {
  return buildPath({
    view: "workflows",
    detail: { kind: "run", workflowName, runId },
  });
}

export function failureHref(
  workflowName: string,
  runId: string,
  stepName?: string,
): string {
  const params = new URLSearchParams({ [FOCUS_PARAM]: FOCUS_FAILURE });
  if (stepName) params.set(STEP_PARAM, stepName);
  return `${runHref(workflowName, runId)}?${params}`;
}

/**
 * navigateTo and RouteLink drop the query string, so this pushes the URL and
 * lets the router read it as after Back/Forward; call it after isPlainLeftClick
 * so modified clicks still open a new tab
 */
export function navigateToHref(href: string): void {
  browserHistory()?.pushState(null, "", href);
  globalThis.dispatchEvent(new Event("popstate"));
}
