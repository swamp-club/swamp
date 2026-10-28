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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { Definition } from "../definitions/definition.ts";
import { ModelType } from "../models/model_type.ts";
import {
  type AggregateResourceResolver,
  baseRecordReadAccessOf,
  readAccessOf,
} from "./commit_authorization.ts";
import {
  createIntent,
  type Intent,
  INTENT_KINDS,
  intentPartition,
  modelRef,
} from "./intent.ts";
import { bindKey, LOCKFILE_RECORD_KEY } from "./intent_key_paths.ts";
import { putOp } from "./op.ts";
import { RecordKey } from "./record_key.ts";
import { base64 } from "./v3_test_helpers.ts";

const TYPES = ["acme/web", "@swamp/aws-ec2", "acme/locked"];
const CONTROL_TYPES: Record<string, string> = {
  grant: "@swamp/grant",
  group: "@swamp/group",
  token: "@swamp/server-token",
  "worker-token": "@swamp/enrollment-token",
  worker: "@swamp/worker",
};
const NAMES = ["vpc", "web", "net", "shared"];
const STAMP = "2026-01-01T00-00-00-000Z";

/** A resolver whose answers come from the generated world. */
class WorldResolver implements AggregateResourceResolver {
  constructor(
    private readonly known: boolean,
    private readonly tags: Record<string, string> | undefined,
  ) {}
  model(ref: { type: string; id: string }) {
    if (!this.known) return Promise.resolve(undefined);
    const definition = Definition.create(
      {
        id: ref.id,
        name: "web",
        type: ref.type,
        tags: this.tags ?? {},
      } as Parameters<typeof Definition.create>[0],
    );
    return Promise.resolve({ definition, type: ModelType.create(ref.type) });
  }
  definitionTags() {
    return Promise.resolve(this.tags);
  }
  workflow() {
    return Promise.resolve(
      this.known ? { name: "deploy", tags: this.tags } : undefined,
    );
  }
  keyOwner() {
    return Promise.resolve(undefined);
  }
  isRestrictedType(type: ModelType) {
    return type.normalized === "acme/locked";
  }
}

/** One intent of `kind` over the generated identities. */
function intentOf(
  kind: Intent["kind"],
  type: string,
  id: string,
  name: string,
  other: string,
  version: number,
): Intent {
  const control = CONTROL_TYPES[kind.split(".")[0]];
  const model = modelRef(ModelType.create(control ?? type), id);
  const run = { workflowId: id, runId: other };
  const definition = (definitionKind: string) => ({
    kind: definitionKind,
    name,
  });
  switch (kind) {
    case "data.save":
    case "data.append":
      return createIntent({ kind, model, name, version });
    case "data.delete":
    case "data.gc":
      return createIntent({ kind, model, name });
    case "data.rename":
      return createIntent({ kind, model, name, to: "renamed" });
    case "output.save":
    case "output.delete":
      return createIntent({ kind, model, outputId: "o" });
    case "run.create":
    case "run.update":
    case "run.delete":
    case "run-snapshot.save":
    case "run-snapshot.delete":
      return createIntent({ kind, run });
    case "definition.create":
    case "definition.edit":
    case "definition.delete":
      return createIntent({
        kind,
        definition: definition(
          ["model", "workflow", "vault"][version % 3],
        ),
      });
    case "evaluated-workflow.save":
    case "evaluated-workflow.delete":
      return createIntent({ kind, definition: definition("workflow") });
    case "definition.rename-to":
      return createIntent({
        kind,
        definition: definition(version % 2 ? "model" : "workflow"),
        from: "old",
      });
    case "definition.rename-from":
      return createIntent({
        kind,
        definition: definition(version % 2 ? "model" : "workflow"),
        to: "new",
      });
    case "auto-definition.save":
    case "auto-definition.delete":
      return createIntent({ kind, autoDefinition: { id } });
    case "lockfile.write":
      return createIntent({ kind });
    default:
      return createIntent({ kind, model });
  }
}

/**
 * Keys of every layout the repositories write, for any aggregate: the
 * binding picks the ones the intent owns.
 */
function candidateKeys(
  type: string,
  id: string,
  name: string,
  version: number,
): string[] {
  const keys: string[] = [LOCKFILE_RECORD_KEY];
  for (const t of [type, ...Object.values(CONTROL_TYPES)]) {
    for (const n of [name, "renamed", "main", "grant-main"]) {
      const data = `data/${t}/${id}/${n}`;
      keys.push(
        `${data}/${version}/raw`,
        `${data}/${version}/metadata.yaml`,
        `${data}/latest`,
      );
    }
    keys.push(
      `outputs/${t}/create/${id}-${STAMP}.yaml`,
      `definitions-evaluated/${t}/${id}.yaml`,
      `definitions-evaluated/${t}/${name}.yaml`,
      `auto-definitions/${t}/${id}.yaml`,
      `auto-definitions/${t}/${name}.yaml`,
      `config/models/${t}/${name}.yaml`,
      `config/models/${t}/old.yaml`,
      `config/models/${t}/new.yaml`,
      `config/models/${t}/${id}.yaml`,
      `config/vaults/${t}/${id}.yaml`,
    );
  }
  for (const n of [name, "old", "new", id]) {
    keys.push(
      `config/workflows/workflow-${n}.yaml`,
      `workflows-evaluated/workflow-${n}.yaml`,
    );
  }
  keys.push(
    `workflow-runs/${id}/workflow-run-${id}.yaml`,
    `workflows-evaluated/runs/${id}/evaluated-workflow.yaml`,
  );
  return keys;
}

Deno.test("baseRecordReadAccessOf: a compacted record always needs what the feed needs of the put that wrote it", async () => {
  let checked = 0;
  const kinds = new Set<string>();
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(...INTENT_KINDS),
      fc.constantFrom(...TYPES),
      fc.uuid({ version: 4 }).map((id) => id.toLowerCase()),
      fc.constantFrom(...NAMES),
      fc.integer({ min: 1, max: 6 }),
      fc.boolean(),
      fc.option(
        fc.constantFrom<Record<string, string>>({ team: "infra" }, {
          env: "prod",
        }),
        {
          nil: undefined,
        },
      ),
      async (kind, type, id, name, version, known, tags) => {
        const intent = intentOf(kind, type, id, name, id, version);
        const resolver = new WorldResolver(known, tags);
        const partition = intentPartition(intent);
        for (const raw of candidateKeys(type, id, name, version)) {
          const key = RecordKey.create(raw);
          // Only a put leaves a record in the base.
          if (!bindKey(intent, "put", key).ok) continue;
          const op = await putOp({ intent, key, inline: base64("x") });
          const feed = await readAccessOf(op, resolver);
          const base = await baseRecordReadAccessOf(partition, key, resolver);
          checked++;
          kinds.add(kind);
          if (feed === undefined) continue;
          assert(
            base.some((access) =>
              JSON.stringify(access) === JSON.stringify(feed)
            ),
            `${kind} ${raw}: the base needs ${
              JSON.stringify(base)
            } but the feed needs ${JSON.stringify(feed)}`,
          );
        }
      },
    ),
    { numRuns: 300 },
  );
  // Every intent kind that puts a record was exercised with a key it owns.
  const putting = INTENT_KINDS.filter((kind) =>
    !kind.endsWith(".delete") && kind !== "definition.rename-from"
  );
  assert(checked > 0);
  assertEquals(
    putting.filter((kind) => !kinds.has(kind)),
    [],
    "intent kinds never checked with a key they own",
  );
});
