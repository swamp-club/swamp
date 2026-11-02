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

/**
 * the report is ambient for all passes. AsyncLocalStorage reaches a generator
 * body only per next() call, so enter it around plain async code, never a
 * generator; re-enter around each part split by a yield.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RejectionReport {
  readonly reported: Set<string>;
}

export function createRejectionReport(): RejectionReport {
  return { reported: new Set() };
}

const ambientReport = new AsyncLocalStorage<RejectionReport>();

export function runWithRejectionReport<T>(
  report: RejectionReport,
  fn: () => T,
): T {
  return ambientReport.run(report, fn);
}

export function firstRejection(raw: string): boolean {
  const report = ambientReport.getStore();
  if (report === undefined) return true;
  if (report.reported.has(raw)) return false;
  report.reported.add(raw);
  return true;
}
