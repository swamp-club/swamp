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

import type { DataLifecycle } from "./data_metadata.ts";

export interface DataRecord {
  id: string;
  name: string;
  version: number;
  isLatest: boolean;
  createdAt: string;
  // which repo produced this data within a shared datastore; empty string in
  // solo mode
  namespace: string;
  attributes: Record<string, unknown>;
  tags: Record<string, string>;
  modelName: string;
  modelId: string;
  modelType: string;
  specName: string;
  dataType: string;
  contentType: string;
  lifetime: string;
  // a count for a count policy, a duration string otherwise; empty when unknown
  // (a foreign row from a catalog export written before the field existed)
  garbageCollection: number | string;
  // deleted for a deletion marker, active otherwise; empty when unknown (a
  // foreign row from an older catalog export)
  lifecycle: DataLifecycle | "";
  ownerType: string;
  streaming: boolean;
  size: number;
  content: unknown;
  // local path of this version's content, set only by the CEL data.* functions
  // when the file is on this host; empty otherwise (foreign namespace,
  // ephemeral, not present locally, non-CEL callers)
  path: string;

  // Provenance fields — promoted from tags/ownerDefinition to first-class.
  // Empty string when the data was not produced inside a workflow.
  ownerRef: string;
  workflowRunId: string;
  workflowName: string;
  jobName: string;
  stepName: string;
  source: string;
}

export interface FileDataRecord {
  id: string;
  version: number;
  createdAt: string;
  path: string;
  size: number;
  contentType: string;
}
