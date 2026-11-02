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

import type { ReportContext } from "./report_context.ts";
import {
  BEHAVIOR_REPORT_SCOPE,
  MODEL_REPORT_SCOPE,
} from "../terminology/behavior_aliases.ts";

export type ReportScope = "method" | "model" | "workflow";

/** behavior is stored as model; every other scope is returned unchanged */
export function canonicalReportScope(scope: string): string {
  return scope === BEHAVIOR_REPORT_SCOPE ? MODEL_REPORT_SCOPE : scope;
}

export interface ReportResult {
  markdown: string;
  json: Record<string, unknown>;
}

export interface ReportDefinition {
  description: string;
  scope: ReportScope;
  labels?: string[];
  execute(context: ReportContext): Promise<ReportResult>;
}
