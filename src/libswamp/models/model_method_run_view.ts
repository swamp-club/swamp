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

export interface DataArtifactView {
  id: string;
  name: string;
  path: string;
  attributes?: Record<string, unknown>;
}

export interface ReportResultView {
  name: string;
  scope?: string;
  success: boolean;
  markdown?: string;
  json?: Record<string, unknown>;
  error?: string;
}

export interface ModelReportView {
  modelId: string;
  modelName: string;
  modelType: string;
  status: "succeeded" | "failed";
  reports: Record<string, ReportResultView>;
}

/**
 * conflict: another process wrote that version first and the datastore keeps
 * its copy, so an artifact naming it names data that does not exist;
 * unauthorized: credentials refused; deferred: lock was busy
 */
export interface UnpublishedVersionView {
  dataName: string;
  version: number;
  reason: "conflict" | "unauthorized" | "deferred";
}

export interface ModelMethodRunView {
  modelId: string;
  modelName: string;
  modelType: string;
  methodName: string;
  status: "succeeded" | "failed" | "cancelled";
  duration?: number;
  outputId: string;
  logFile?: string;
  dataArtifacts: DataArtifactView[];
  reports?: Record<string, ReportResultView>;
  globalArguments?: Record<string, unknown>;
  methodArguments?: Record<string, unknown>;
  initiatedBy?: string;
  unpublishedVersions?: UnpublishedVersionView[];
}
