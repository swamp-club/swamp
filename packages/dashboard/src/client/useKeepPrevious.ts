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

import { useRef } from "react";

interface Held<T> {
  key: string;
  value: T;
}

/**
 * The held value after a render: the new value when there is one, else the
 * previous one only if it was held under the same `key`.
 */
export function holdLatest<T>(
  held: Held<T> | null,
  value: T | null,
  key: string,
  reset = false,
): Held<T> | null {
  if (reset) return null;
  if (value !== null) return { key, value };
  return held?.key === key ? held : null;
}

/**
 * The latest non-null value, held through the gaps where a new request
 * has not answered yet — so paging or refiltering a server-backed list
 * keeps the previous rows on screen instead of flashing empty. `reset`
 * drops the held value (e.g. when there is nothing to request). A changed
 * `key` (e.g. a new time range) drops it too, so a different question
 * never shows the previous question's answer.
 */
export function useKeepPrevious<T>(
  value: T | null,
  reset = false,
  key = "",
): T | null {
  const held = useRef<Held<T> | null>(null);
  held.current = holdLatest(held.current, value, key, reset);
  return held.current?.value ?? null;
}
