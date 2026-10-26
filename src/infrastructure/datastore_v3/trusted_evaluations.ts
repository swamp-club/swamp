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
 * The evaluated definitions and workflows serve may run with
 * `--last-evaluated` on a v3 datastore (swamp-club#3922).
 *
 * An evaluation holds resolved values and the expressions its source
 * authored: running one skips evaluation and its checks. Serve saves an
 * evaluation only for a caller who may run what it evaluates, but a team
 * member's client forwards the evaluations its own runs write, which serve
 * cannot re-derive. So serve runs only evaluations it wrote itself: the
 * read model records who wrote each record, and an evaluation a forwarded
 * commit wrote, or one whose writer is unknown (from before the read model
 * recorded writers, or loaded from a compacted base), is refused with a
 * request to evaluate on serve.
 *
 * The bytes parsed are the ones the writer check vouched for: the record is
 * read with its digest, never re-read from the file after the check.
 *
 * @module
 */

import { isFilenameSafeDefinitionName } from "../../domain/definitions/definition.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { UserError } from "../../domain/errors.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { isFilenameSafeName } from "../../domain/workflows/workflow.ts";
import {
  type EvaluatedDefinitionCache,
  parseEvaluatedDefinitionCache,
} from "../persistence/yaml_evaluated_definition_repository.ts";
import {
  type EvaluatedWorkflowCache,
  parseEvaluatedWorkflowCache,
} from "../persistence/yaml_evaluated_workflow_repository.ts";
import type { V3Datastore } from "./v3_datastore.ts";

/** Loads the evaluations serve may run. */
export interface EvaluationTrust {
  /**
   * The evaluated definition of a behavior, when serve wrote it; null when
   * there is none.
   *
   * @throws UserError when the stored evaluation was not serve's own
   */
  definition(
    type: ModelType,
    name: string,
  ): Promise<EvaluatedDefinitionCache | null>;
  /**
   * The evaluated workflow of a workflow, when serve wrote it; null when
   * there is none.
   *
   * @throws UserError when the stored evaluation was not serve's own
   */
  workflow(name: string): Promise<EvaluatedWorkflowCache | null>;
}

/** The {@link EvaluationTrust} of a v3 datastore's read model. */
export function v3EvaluationTrust(
  v3: Pick<V3Datastore, "namespace" | "readModel">,
  repos: {
    readonly definitionRepo: Pick<DefinitionRepository, "findByName">;
    readonly workflowRepo: Pick<WorkflowRepository, "findByName">;
  },
): EvaluationTrust {
  /** The trusted bytes at the first key holding a record, or null. */
  const trusted = async (
    partition: PartitionKey,
    keys: readonly string[],
    what: string,
  ): Promise<string | null> => {
    for (const key of keys) {
      const record = await v3.readModel.liveRecord(
        v3.namespace,
        partition,
        key,
      );
      if (record === undefined) continue;
      if (record.writer !== "") {
        throw new UserError(
          `The evaluation of ${what} was not made on this server, so it ` +
            `cannot be run with --last-evaluated here. Evaluate it on this ` +
            `server first.`,
          "evaluation_not_trusted",
        );
      }
      const found = await v3.readModel.recordBytes(
        v3.namespace,
        partition,
        key,
      );
      if (found === undefined || found.record.sha256 !== record.sha256) {
        throw new UserError(
          `The evaluation of ${what} changed while it was read. Run again.`,
          "evaluation_not_trusted",
        );
      }
      return new TextDecoder().decode(found.bytes);
    }
    return null;
  };
  return {
    async definition(type, name) {
      const definition = await repos.definitionRepo.findByName(type, name);
      if (definition === null) return null;
      const keys = [
        ...(isFilenameSafeDefinitionName(name)
          ? [`definitions-evaluated/${type.normalized}/${name}.yaml`]
          : []),
        `definitions-evaluated/${type.normalized}/${definition.id}.yaml`,
      ];
      const content = await trusted(
        partitionOf({ kind: "model", type, id: definition.id }),
        keys,
        `behavior ${name}`,
      );
      if (content === null) return null;
      const cache = parseEvaluatedDefinitionCache(content);
      return cache !== null && cache.definition.id === definition.id
        ? cache
        : null;
    },
    async workflow(name) {
      const workflow = await repos.workflowRepo.findByName(name);
      if (workflow === null) return null;
      const keys = [
        ...(isFilenameSafeName(name)
          ? [`workflows-evaluated/workflow-${name}.yaml`]
          : []),
        `workflows-evaluated/workflow-${workflow.id}.yaml`,
      ];
      const content = await trusted(
        partitionOf({ kind: "config", definitionKind: "workflow", name }),
        keys,
        `workflow ${name}`,
      );
      if (content === null) return null;
      const cache = parseEvaluatedWorkflowCache(content);
      return cache !== null && cache.workflow.id === workflow.id ? cache : null;
    },
  };
}
