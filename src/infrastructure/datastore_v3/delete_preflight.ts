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

import type { Op } from "../../domain/datastore_v3/op.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import {
  ConfigChanges,
  ModelChanges,
} from "../../domain/datastore_v3/repository_changes.ts";
import type { TypedChange } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { ServeDatastoreClient } from "./serve_datastore_client.ts";

export interface DeletePlan {
  readonly type: ModelType;
  readonly definition: { readonly id: string; readonly name: string };
  readonly outputs: readonly { id: string; methodName: string }[];
  readonly data: readonly { name: string; version: number }[];
}

function removalOf(change: TypedChange): Op {
  if (!("op" in change)) {
    throw new Error("Internal error: a removal staged a write");
  }
  return change.op;
}

// a file name the output key rule accepts; only the access it needs is judged
const ANY_OUTPUT_STAMP = "1970-01-01T00-00-00-000Z";

// serve's caps on one authorize request
const MAX_OPS_PER_COMMIT = 64;
const MAX_COMMITS = 16;

/**
 * one removal per data name, since a key can be refused on its own, and one
 * output, whose access is the behavior's; the definition comes last, as it
 * commits last. Names past serve's caps are judged at commit
 */
export function deleteRemovalCommits(
  plan: DeletePlan,
): { partition: PartitionKey; ops: Op[] }[] {
  const id = plan.definition.id;
  const model = new ModelChanges(plan.type, id);
  const modelOps: Op[] = [];
  const output = plan.outputs[0];
  if (output !== undefined) {
    modelOps.push(
      removalOf(model.removeOutput(
        output.id,
        output.methodName,
        `${id}-${ANY_OUTPUT_STAMP}.yaml`,
      )),
    );
  }
  const seen = new Set<string>();
  for (const data of plan.data) {
    if (seen.has(data.name)) continue;
    seen.add(data.name);
    modelOps.push(
      removalOf(model.removeVersion("data.delete", data.name, data.version)[0]),
    );
  }
  const commits: { partition: PartitionKey; ops: Op[] }[] = [];
  for (
    let start = 0;
    start < modelOps.length && commits.length < MAX_COMMITS - 1;
    start += MAX_OPS_PER_COMMIT
  ) {
    commits.push({
      partition: model.partition,
      ops: modelOps.slice(start, start + MAX_OPS_PER_COMMIT),
    });
  }
  const definition = new ConfigChanges("model", plan.definition.name).remove(
    "definition.delete",
    RecordKey.create(
      `config/models/${plan.type.normalized}/${plan.definition.name}.yaml`,
    ),
  );
  commits.push({
    partition: definition.partition,
    ops: [removalOf(definition)],
  });
  return commits;
}

export async function preflightDeleteAtServe(
  client: Pick<ServeDatastoreClient, "authorizeRemovals">,
  plan: DeletePlan,
  signal: AbortSignal,
): Promise<{ code: string; message: string } | undefined> {
  const verdicts = await client.authorizeRemovals(
    deleteRemovalCommits(plan),
    signal,
  );
  const refused = verdicts?.find((verdict) => !verdict.ok);
  if (refused === undefined || refused.ok) return undefined;
  return {
    code: "forbidden",
    message: `Nothing was deleted: ${refused.message}`,
  };
}
