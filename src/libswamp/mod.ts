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

export { createLibSwampContext, type LibSwampContext } from "./context.ts";
export {
  alreadyExists,
  cancelled,
  invalidApiKey,
  notAuthenticated,
  notFound,
  type SwampError,
  validationFailed,
} from "./errors.ts";
export {
  consumeStream,
  type EventHandlers,
  type HasTerminals,
  result,
  type StreamEvent,
  withDefaults,
} from "./stream.ts";
export { AsyncQueue } from "./stream/async_queue.ts";
export { merge } from "./stream/merge.ts";
export { assertCompletes, assertErrors, collect } from "./testing.ts";

// Auth operations
export {
  type AuthDeps,
  type AuthWhoamiEvent,
  createAuthDeps,
  whoami,
  type WhoamiIdentity,
} from "./auth/whoami.ts";

// Workflow operations
export {
  extractStepArtifacts,
  inputValidationFailed,
  toRunData,
  workflowExecutionFailed,
  workflowNotFound,
  workflowRun,
  type WorkflowRunDeps,
  type WorkflowRunEvent,
  type WorkflowRunInput,
} from "./workflows/run.ts";
export type { MethodExecutionEvent } from "../domain/models/method_events.ts";
export {
  type DataArtifactRefData,
  type JobRunView,
  type StepArtifactsData,
  type StepRunView,
  type WorkflowRunView,
} from "./workflows/workflow_run_view.ts";

// Model operations
export {
  methodExecutionFailed,
  modelMethodRun,
  type ModelMethodRunDeps,
  type ModelMethodRunEvent,
  type ModelMethodRunInput,
  modelNotFound,
  noEvaluatedDefinition,
  type RunLog,
  unknownMethod,
  unknownModelType,
} from "./models/run.ts";
export {
  type DataArtifactView,
  type ModelMethodRunView,
} from "./models/model_method_run_view.ts";
export {
  createModelGetDeps,
  modelGet,
  type ModelGetData,
  type ModelGetDeps,
  type ModelGetEvent,
} from "./models/get.ts";
export {
  type ArtifactsData,
  createModelOutputGetDeps,
  type ErrorData,
  type GlobalOutputInfo,
  modelOutputGet,
  type ModelOutputGetData,
  type ModelOutputGetDeps,
  type ModelOutputGetEvent,
  type OutputInfo,
  type ProvenanceData,
} from "./models/output_get.ts";
export {
  createModelMethodDescribeDeps,
  modelMethodDescribe,
  type ModelMethodDescribeData,
  type ModelMethodDescribeDeps,
  type ModelMethodDescribeEvent,
} from "./models/method_describe.ts";

// Workflow get operations
export {
  createWorkflowGetDeps,
  isUuid,
  workflowGet,
  type WorkflowGetData,
  type WorkflowGetDeps,
  type WorkflowGetEvent,
} from "./workflows/get.ts";
export {
  createWorkflowHistoryGetDeps,
  workflowHistoryGet,
  type WorkflowHistoryGetDeps,
  type WorkflowHistoryGetEvent,
} from "./workflows/history_get.ts";

// Vault operations
export {
  createVaultGetDeps,
  type VaultConfigInfo,
  vaultGet,
  type VaultGetData,
  type VaultGetDeps,
  type VaultGetEvent,
} from "./vaults/get.ts";
export {
  createVaultDescribeDeps,
  vaultDescribe,
  type VaultDescribeData,
  type VaultDescribeDeps,
  type VaultDescribeEvent,
} from "./vaults/describe.ts";

// Data operations
export {
  createDataGetDeps,
  dataGet,
  type DataGetData,
  type DataGetDeps,
  type DataGetEvent,
  type DataGetInput,
} from "./data/get.ts";

// Type operations
export {
  createTypeDescribeDeps,
  typeDescribe,
  type TypeDescribeData,
  type TypeDescribeDeps,
  type TypeDescribeEvent,
} from "./types/describe.ts";
export {
  type DataOutputSpecDescribeData,
  type MethodDescribeData,
  toMethodDescribeData,
  zodToJsonSchema,
} from "./types/schema_helpers.ts";
