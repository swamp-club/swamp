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

import { reportRegistry } from "../report_registry.ts";
import { methodSummaryReport } from "./method_summary_report.ts";
import { workflowSummaryReport } from "./workflow_summary_report.ts";

/** Built-in method-scope report names injected as candidates at call sites. */
export const BUILTIN_METHOD_REPORTS = ["@swamp/method-summary"];

/** Built-in workflow-scope report names injected as candidates at call sites. */
export const BUILTIN_WORKFLOW_REPORTS = ["@swamp/workflow-summary"];

// Register built-in reports (guarded to be idempotent across re-imports)
if (!reportRegistry.has("@swamp/method-summary")) {
  reportRegistry.register("@swamp/method-summary", methodSummaryReport);
}
if (!reportRegistry.has("@swamp/workflow-summary")) {
  reportRegistry.register("@swamp/workflow-summary", workflowSummaryReport);
}
