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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

/** Schema data for all workflow-related Zod schemas. */
export interface WorkflowSchemaData {
  workflow: object;
  job: object;
  jobDependency: object;
  step: object;
  stepDependency: object;
  stepTask: object;
  triggerCondition: object;
}

export type WorkflowSchemaEvent =
  | { kind: "completed"; data: WorkflowSchemaData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the workflow schema operation. */
export interface WorkflowSchemaDeps {
  getSchemas: () => WorkflowSchemaData;
}

/** Yields the JSON Schema representation of all workflow schemas. */
export async function* workflowSchema(
  _ctx: LibSwampContext,
  deps: WorkflowSchemaDeps,
): AsyncIterable<WorkflowSchemaEvent> {
  yield { kind: "completed", data: deps.getSchemas() };
}
