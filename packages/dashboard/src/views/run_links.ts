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

// Links into a run page. Every page that links to a failed run's log
// builds the URL here, so "View failure log" means the same thing from the
// workflow list, the executions table and the run itself.

import { buildPath } from "../routes.ts";
import { browserHistory } from "../components/dom_types.ts";

/** `?focus=failure` opens the run on its failed job and step log. */
export const FOCUS_PARAM = "focus";
export const FOCUS_FAILURE = "failure";
/** `?step=<name>` picks which failed step, when there are several. */
export const STEP_PARAM = "step";

/** The run page's path. */
export function runHref(workflowName: string, runId: string): string {
  return buildPath({
    view: "workflows",
    detail: { kind: "run", workflowName, runId },
  });
}

/**
 * The run page opened straight on its failure: the failed job selected,
 * its panel open, the failed step expanded with its log scrolled to the
 * end. `stepName` targets one step; without it the first step that failed
 * the run is shown.
 */
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
 * In-app navigation to a dashboard href that carries a query string (which
 * `navigateTo` and `RouteLink` drop). Pushes the URL and lets the router
 * and the destination page read it as they would after Back/Forward.
 * Use it from the `onClick` of an `<a href={failureHref(...)}>` after
 * checking `isPlainLeftClick`, so modified clicks still open a new tab.
 */
export function navigateToHref(href: string): void {
  browserHistory()?.pushState(null, "", href);
  globalThis.dispatchEvent(new Event("popstate"));
}
