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

/** an omitted value is only in the run's record, so it is named, not shown */
export function inputPairs(
  item: { inputs?: Record<string, unknown>; inputsOmitted?: string[] },
): string[] {
  return [
    ...Object.entries(item.inputs ?? {}).map(([k, v]) => `${k}=${String(v)}`),
    ...(item.inputsOmitted ?? []).map((k) => `${k}=… (omitted)`),
  ];
}
