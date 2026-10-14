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
 * Which refused expressions a step has already reported (swamp-club#3402).
 *
 * Every step-time pass over a step's arguments refuses the same expression
 * text that arrived as data, so without a report each refusal would be logged
 * once per pass. The step executor enters a report for each step with
 * {@link runWithRejectionReport}; the refusal warnings check it through
 * {@link firstRejection} and log a raw text once per step. With no report
 * entered, every refusal is logged, as before.
 *
 * The report is ambient so that every pass a step runs shares it without each
 * one taking it as a parameter. `AsyncLocalStorage` reaches an async
 * generator's body only through each `next()` call, so a report must be
 * entered around plain async code, never around a generator; a step whose
 * evaluation is split by a `yield` enters the same report around each part.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The raw expression texts one step has reported as refused. */
export interface RejectionReport {
  readonly reported: Set<string>;
}

/** A report with nothing reported yet. */
export function createRejectionReport(): RejectionReport {
  return { reported: new Set() };
}

const ambientReport = new AsyncLocalStorage<RejectionReport>();

/** Runs `fn` with `report` as the step's rejection report. */
export function runWithRejectionReport<T>(
  report: RejectionReport,
  fn: () => T,
): T {
  return ambientReport.run(report, fn);
}

/**
 * Whether the refusal of `raw` should be logged: true the first time the
 * current report sees it, and always when no report is entered.
 */
export function firstRejection(raw: string): boolean {
  const report = ambientReport.getStore();
  if (report === undefined) return true;
  if (report.reported.has(raw)) return false;
  report.reported.add(raw);
  return true;
}
