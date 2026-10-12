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

/**
 * The latest non-null value, held through the gaps where a new request
 * has not answered yet — so paging or refiltering a server-backed list
 * keeps the previous rows on screen instead of flashing empty. `reset`
 * drops the held value (e.g. when there is nothing to request).
 */
export function useKeepPrevious<T>(value: T | null, reset = false): T | null {
  const held = useRef<T | null>(null);
  if (reset) held.current = null;
  else if (value !== null) held.current = value;
  return reset ? null : held.current;
}
