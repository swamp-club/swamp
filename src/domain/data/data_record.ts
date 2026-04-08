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

/**
 * Record returned by data access functions.
 * Represents a single version of a named data item with parsed content.
 *
 * Used by:
 * - CEL expression data functions (data.version, data.latest, etc.)
 * - DataAccessService for cross-model data reads
 * - context.readModelData() in execute functions
 */
export interface DataRecord {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  attributes: Record<string, unknown>;
  tags: Record<string, string>;
  modelName: string;
  modelType: string;
  specName: string;
  dataType: string;
  contentType: string;
  lifetime: string;
  ownerType: string;
  streaming: boolean;
  size: number;
  content: string;

  // Provenance fields — promoted from tags/ownerDefinition to first-class.
  // Empty string when the data was not produced inside a workflow.
  ownerRef: string;
  workflowRunId: string;
  workflowName: string;
  jobName: string;
  stepName: string;
  source: string;
}
