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

import type { SwampError } from "../errors.ts";

/** One method on a creek, with JSON-Schema-converted arg/return types. */
export interface CreekMethodDetail {
  name: string;
  description: string;
  arguments: object;
  returns?: object;
  strictReturns: boolean;
}

/** Full creek definition metadata. */
export interface CreekDescribeData {
  type: string;
  version: string;
  description?: string;
  methods: CreekMethodDetail[];
}

/** One entry in the type search results. */
export interface CreekTypeSearchItem {
  type: string;
  version: string;
  description?: string;
  methodCount: number;
}

export interface CreekTypeSearchData {
  query: string;
  results: CreekTypeSearchItem[];
}

export interface CreekCallData {
  type: string;
  method: string;
  args: Record<string, unknown>;
  result: unknown;
}

// --- Event types ---

export type CreekDescribeEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: CreekDescribeData }
  | { kind: "error"; error: SwampError };

export type CreekTypeSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: CreekTypeSearchData }
  | { kind: "error"; error: SwampError };

export type CreekCallEvent =
  | { kind: "running" }
  | { kind: "completed"; data: CreekCallData }
  | { kind: "error"; error: SwampError };
