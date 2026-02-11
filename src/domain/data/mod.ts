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

export { createDataId, type DataId, generateDataId } from "./data_id.ts";

export {
  type DataMetadata,
  DataMetadataSchema,
  type GarbageCollectionPolicy,
  GarbageCollectionSchema,
  type Lifetime,
  LifetimeSchema,
  type OwnerDefinition,
  OwnerDefinitionSchema,
  type OwnerType,
  OwnerTypes,
} from "./data_metadata.ts";

export { type CreateDataProps, Data } from "./data.ts";

export { type UnifiedDataRepository } from "./repositories.ts";

export {
  type WorkflowDataItem,
  WorkflowDataService,
} from "./workflow_data_service.ts";
