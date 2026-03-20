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

import type { SwampError } from "../errors.ts";

/**
 * Summary of a stored report (no content).
 */
export interface StoredReportSummary {
  reportName: string;
  reportScope: string;
  modelId: string;
  modelName: string;
  modelType: string;
  version: number;
  createdAt: string;
  workflowName?: string;
  dataName: string;
  varySuffix?: string;
}

/**
 * Full stored report detail including content.
 */
export interface StoredReportDetail extends StoredReportSummary {
  markdown: string;
  json: Record<string, unknown>;
}

/**
 * Report definition metadata from the registry.
 */
export interface ReportDefinitionDetail {
  name: string;
  description: string;
  scope: string;
  labels: string[];
}

// --- Event types ---

export type ReportSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: { reports: StoredReportSummary[] } }
  | { kind: "error"; error: SwampError };

export type ReportGetEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: StoredReportDetail }
  | { kind: "error"; error: SwampError };

export type ReportDescribeEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ReportDefinitionDetail }
  | { kind: "error"; error: SwampError };
