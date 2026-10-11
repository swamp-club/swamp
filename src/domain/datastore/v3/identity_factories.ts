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
 * Identity factories for aggregates whose instances never contend
 * (swamp-club#3233).
 *
 * Writers compete only when they change the same aggregate instance. A new
 * workflow run, auto-definition or model output gets a fresh identity, so it
 * is a partition of its own (or, for an output, a key of its own) and no
 * other writer can collide with it.
 *
 * These reuse the generator swamp already uses for each id,
 * `crypto.randomUUID()` (UUID v4: 122 random bits), which already cannot
 * collide in practice, and the id schemas require a UUID. No ULID: a
 * partition orders its commits by seq, so ids need not sort by time.
 *
 * @module
 */

import {
  createDefinitionId,
  type DefinitionId,
} from "../../definitions/definition.ts";
import {
  createModelOutputId,
  type ModelOutputId,
} from "../../models/model_output.ts";
import {
  createWorkflowRunId,
  type WorkflowRunId,
} from "../../workflows/workflow_id.ts";

/** Gives each new workflow run its own identity, and so its own partition. */
export const WorkflowRunFactory = {
  newRunId(): WorkflowRunId {
    return createWorkflowRunId(crypto.randomUUID());
  },
} as const;

/** Gives each new auto-definition its own identity and partition. */
export const DefinitionFactory = {
  newAutoDefinitionId(): DefinitionId {
    return createDefinitionId(crypto.randomUUID());
  },
} as const;

/** Gives each new model output its own identity within its model. */
export const ModelOutputFactory = {
  newOutputId(): ModelOutputId {
    return createModelOutputId(crypto.randomUUID());
  },
} as const;
