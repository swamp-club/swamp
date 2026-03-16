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
  cancelled,
  invalidApiKey,
  notAuthenticated,
  type SwampError,
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
