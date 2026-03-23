// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/**
 * The scope at which a report operates.
 */
export type ReportScope = "method" | "model" | "workflow";

/**
 * The result produced by a report execution.
 */
export interface ReportResult {
  /** Human-readable markdown content. */
  markdown: string;
  /** Machine-readable structured data. */
  json: Record<string, unknown>;
}

/**
 * Definition of a report that can be registered and executed.
 */
export interface ReportDefinition {
  /** Human-readable description of what the report produces. */
  description: string;
  /** The scope at which this report operates. */
  scope: ReportScope;
  /** Labels for filtering (e.g., ["cost", "finops"]). */
  labels?: string[];
  /** Execute the report and produce results. */
  execute(context: ReportContext): Promise<ReportResult>;
}
