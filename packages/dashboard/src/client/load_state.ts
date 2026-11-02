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

// One rule for what a request-backed region shows, so no view ever says
// "nothing here" while it is still asking.

export type LoadState = "loading" | "error" | "empty" | "ready";

export interface LoadSource<T = unknown> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * classifies a request for rendering. Data from an earlier answer wins over a
 * later refetch's error or in-flight flag, so a background refresh never blanks
 * a loaded page; `isEmpty` defaults to an empty array
 */
export function loadState<T>(
  source: LoadSource<T>,
  isEmpty: (data: T) => boolean = isEmptyArray,
): LoadState {
  if (source.data === null) return source.error !== null ? "error" : "loading";
  return isEmpty(source.data) ? "empty" : "ready";
}

function isEmptyArray(data: unknown): boolean {
  return Array.isArray(data) && data.length === 0;
}
