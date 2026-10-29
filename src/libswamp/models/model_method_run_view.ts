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
 * Read-model projection of a data artifact produced by a model method run.
 */
export interface DataArtifactView {
  id: string;
  name: string;
  path: string;
  attributes?: Record<string, unknown>;
}

/**
 * Read-model projection of a completed model method run.
 * Presentation-oriented view with computed fields (duration, artifacts).
 */
/**
 * Result of a single report execution for the view.
 */
export interface ReportResultView {
  name: string;
  scope?: string;
  success: boolean;
  markdown?: string;
  json?: Record<string, unknown>;
  error?: string;
}

/**
 * Read-model projection of a completed model method run.
 * Presentation-oriented view with computed fields (duration, artifacts).
 */
/**
 * Read-model projection of a standalone report run (no method execution).
 */
export interface ModelReportView {
  modelId: string;
  modelName: string;
  modelType: string;
  status: "succeeded" | "failed";
  reports: Record<string, ReportResultView>;
}

/**
 * A data version a read or list run wrote that its publish left on this
 * host only (swamp-club#3934). `conflict`: another swamp process wrote the
 * same version first; the datastore keeps that copy and this host now holds
 * it, so an artifact naming this version names data that no longer exists.
 * `unauthorized`: the datastore refused the credentials, as read-only ones.
 */
export interface UnpublishedVersionView {
  dataName: string;
  version: number;
  reason: "conflict" | "unauthorized";
}

/**
 * Read-model projection of a completed model method run.
 * Presentation-oriented view with computed fields (duration, artifacts).
 */
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
  /** Present only when the run's publish left versions unpublished. */
  unpublishedVersions?: UnpublishedVersionView[];
}
