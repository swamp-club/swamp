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
 * serve runs only evaluations it wrote itself; one a forwarded commit wrote, or
 * whose writer is unknown, is refused with a request to evaluate on serve. The
 * bytes parsed are the ones vouched for
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

export const EVALUATION_OTHER_WRITER = "evaluation_other_writer";

const MAX_EVALUATION_BYTES = 16 * 1024 * 1024;

export interface EvaluationTrust {
  definition(
    type: ModelType,
    name: string,
  ): Promise<EvaluatedDefinitionCache | null>;
  workflow(name: string): Promise<EvaluatedWorkflowCache | null>;
}

export function v3EvaluationTrust(
  v3: Pick<V3Datastore, "namespace" | "readModel">,
  repos: {
    readonly definitionRepo: Pick<DefinitionRepository, "findByName">;
    readonly workflowRepo: Pick<WorkflowRepository, "findByName">;
  },
  /**
   * set by a serve-mode checkout, and to empty when its member is unknown: it
   * trusts serve's evaluations and this principal's, never another member's,
   * and any other writer's record refuses. Serve passes none
   */
  ownPrincipal?: string,
): EvaluationTrust {
  /**
   * on serve a key holding another writer's record is passed over, so a
   * forwarded evaluation cannot hide serve's own; a checkout stops at such a
   * key and sets the replay aside
   */
  const trusted = async (
    partition: PartitionKey,
    keys: readonly string[],
    what: string,
  ): Promise<string | null> => {
    // Serve's own commits reach the read model only by catching up: the
    // evaluation serve just saved is read as it is now.
    await v3.readModel.catchUpPartition(
      v3.namespace,
      partition,
      new AbortController().signal,
    );
    let untrusted: "forwarded" | "unknown" | undefined;
    for (const key of keys) {
      const record = await v3.readModel.liveRecord(
        v3.namespace,
        partition,
        key,
      );
      if (record === undefined) continue;
      if (
        record.writer !== "" &&
        (ownPrincipal === undefined || record.writer !== ownPrincipal)
      ) {
        untrusted ??= record.writer === null ? "unknown" : "forwarded";
        // A checkout stops here: any other writer's evaluation sets the run's
        // replay aside, rather than serve's rule of preferring its own.
        if (ownPrincipal !== undefined) break;
        continue;
      }
      if ((record.blob?.size ?? 0) > MAX_EVALUATION_BYTES) {
        throw new UserError(
          `The evaluation of ${what} is larger than serve will run ` +
            `(${MAX_EVALUATION_BYTES} bytes); run it without --last-evaluated.`,
          "evaluation_not_trusted",
        );
      }
      const found = await v3.readModel.recordBytes(
        v3.namespace,
        partition,
        key,
        MAX_EVALUATION_BYTES,
      );
      if (found === undefined || found.record.sha256 !== record.sha256) {
        throw new UserError(
          `The evaluation of ${what} changed while it was read. Run again.`,
          "evaluation_not_trusted",
        );
      }
      return new TextDecoder().decode(found.bytes);
    }
    if (untrusted === "forwarded" && ownPrincipal !== undefined) {
      throw new UserError(
        ownPrincipal === ""
          ? `Serve did not write the last evaluation of ${what}.`
          : `Another member wrote the last evaluation of ${what}.`,
        EVALUATION_OTHER_WRITER,
      );
    }
    if (untrusted === "forwarded") {
      throw new UserError(
        `The evaluation of ${what} was not made on this server, so it ` +
          `cannot be run with --last-evaluated here. Evaluate it on this ` +
          `server first.`,
        "evaluation_not_trusted",
      );
    }
    if (untrusted === "unknown" && ownPrincipal !== undefined) {
      throw new UserError(
        `Serve has no record of who wrote the last evaluation of ${what}. Evaluate it again to save a new one, or run without --last-evaluated.`,
        "evaluation_not_trusted",
      );
    }
    if (untrusted === "unknown") {
      throw new UserError(
        `The evaluation of ${what} was saved before this server recorded ` +
          `who writes evaluations, so it cannot be run with ` +
          `--last-evaluated. Evaluate it on this server again.`,
        "evaluation_not_trusted",
      );
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
