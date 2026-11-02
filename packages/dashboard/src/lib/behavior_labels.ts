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

// "behavior" is the product term; view ids, route view names, request methods
// and payload fields keep the model name

export const BEHAVIORS_LABEL = "Behaviors";

export const NO_BEHAVIORS_TITLE = "No behaviors defined yet";

export const ALL_BEHAVIORS_LABEL = "All behaviors";

export const BEHAVIOR_COLUMN = "Behavior";

export function behaviorNoun(n: number): string {
  return n === 1 ? "behavior" : "behaviors";
}
