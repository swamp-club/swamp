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

// The words both dashboards show for what swamp's code and protocol call
// a model. "Behavior" is the product term (design/primitives/behaviors.md);
// view ids, routes' view names, request methods and payload fields keep
// the model name. React-free, so tests can check the wording directly.

/** The behaviors list: its sidebar entry, page heading and breadcrumb. */
export const BEHAVIORS_LABEL = "Behaviors";

/** The behaviors list's empty state, when the repo defines none. */
export const NO_BEHAVIORS_TITLE = "No behaviors defined yet";

/** The data page's filter option for every behavior. */
export const ALL_BEHAVIORS_LABEL = "All behaviors";

/** The data table's column, and the filter's accessible name. */
export const BEHAVIOR_COLUMN = "Behavior";

/** "behavior" or "behaviors" for a count, as stat tiles show it. */
export function behaviorNoun(n: number): string {
  return n === 1 ? "behavior" : "behaviors";
}
