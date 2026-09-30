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

import type { RunSensitiveValues } from "../secrets/mod.ts";

/**
 * Key under which an expression context carries its run's
 * RunSensitiveValues. A symbol is invisible to CEL, which only reads string
 * keys, and object spread copies it, so every derived context shares the same
 * run-scoped record by reference.
 */
const SENSITIVE_VALUES: unique symbol = Symbol("swamp.sensitiveValues");

interface CarriesSensitiveValues {
  [SENSITIVE_VALUES]?: RunSensitiveValues;
}

/** Attaches the run's sensitive-value record to an expression context. */
export function attachSensitiveValues<T extends object>(
  context: T,
  values: RunSensitiveValues,
): T {
  (context as CarriesSensitiveValues)[SENSITIVE_VALUES] = values;
  return context;
}

/** The run's sensitive-value record carried by a context, if any. */
export function sensitiveValuesOf(
  context: object | undefined,
): RunSensitiveValues | undefined {
  return (context as CarriesSensitiveValues | undefined)?.[SENSITIVE_VALUES];
}
