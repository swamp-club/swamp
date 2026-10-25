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
import type { AccessResource } from "../access/access_decision_service.ts";
import type { Action } from "../access/action.ts";
import { Definition } from "../definitions/definition.ts";
import { ModelType } from "../models/model_type.ts";
import {
  type AggregateResourceResolver,
  authorizeCommit,
  type CallerAuthority,
  checkCommitBindings,
  type CommitAuthorization,
  type KeyOwnership,
  readAccessOf,
  writeAccessOf,
} from "./commit_authorization.ts";
import { createIntent, type Intent, INTENT_KINDS, modelRef } from "./intent.ts";
import { bindKey, LOCKFILE_RECORD_KEY } from "./intent_key_paths.ts";
import {
  dataVersionOp,
  leaseOp,
  type Op,
  type PutOp,
  putOp,
  type TombstoneOp,
  tombstoneOp,
} from "./op.ts";
import { partitionOf } from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";
import {
  base64,
  metadata,
  MODEL_ID,
  MODEL_TYPE,
  modelIntent,
  modelPartition,
  SAMPLE_RUN_ID,
  SAMPLE_WORKFLOW_ID,
  sampleIntent,
} from "./v3_test_helpers.ts";

const DATA = `data/${MODEL_TYPE.normalized}/${MODEL_ID}`;
const OTHER_ID = "11111111-2222-4333-8444-555555555555";

/** A resolver over fixed aggregates; every lookup is recorded. */
class FakeResolver implements AggregateResourceResolver {
  readonly owners = new Map<string, KeyOwnership>();
  readonly restricted = new Set<string>();
  definitions = new Map<string, Definition>();
  workflows = new Map<
    string,
    { name: string; tags?: Record<string, string> }
  >();

  model(ref: { type: string; id: string }) {
    const definition = this.definitions.get(ref.id);
    return Promise.resolve(
      definition === undefined
        ? undefined
        : { definition, type: ModelType.create(ref.type) },
    );
  }
  definitionTags() {
    return Promise.resolve(undefined);
  }
  workflow(workflowId: string) {
    return Promise.resolve(this.workflows.get(workflowId));
  }
  keyOwner(key: string) {
    return Promise.resolve(this.owners.get(key));
  }
  isRestrictedType(type: ModelType) {
    return this.restricted.has(type.normalized);
  }
}

/** An authority that allows exactly the (action, kind:name) pairs given. */
class FakeAuthority implements CallerAuthority {
  readonly asked: {
    action: Action;
    resource: AccessResource;
    every: boolean;
  }[] = [];
  constructor(private readonly allowed: readonly string[]) {}
  allows(action: Action, resource: AccessResource, every = false): boolean {
    this.asked.push({ action, resource, every });
    return this.allowed.includes(
      `${action} ${resource.kind}:${resource.name}`,
    ) ||
      this.allowed.includes(`${action} ${resource.kind}:*`) ||
      this.allowed.includes("*");
  }
}

function web(): Definition {
  return Definition.create(
    {
      id: MODEL_ID,
      name: "web",
      type: MODEL_TYPE.normalized,
      tags: { team: "infra" },
    } as Parameters<typeof Definition.create>[0],
  );
}

async function save(name = "vpc", version = 1): Promise<Op[]> {
  const intent = modelIntent({ kind: "data.save", name, version });
  return [
    await putOp({
      intent,
      key: RecordKey.create(`${DATA}/${name}/${version}/raw`),
      inline: base64("x"),
    }),
    await putOp({
      intent,
      key: RecordKey.create(`${DATA}/${name}/${version}/metadata.yaml`),
      inline: base64("m"),
    }),
    dataVersionOp({
      key: RecordKey.create(`${DATA}/${name}/${version}/metadata.yaml`),
      metadata: metadata(name, version),
    }),
  ];
}

function assertRefused(
  result: CommitAuthorization,
  reason: string,
  opIndex?: number,
): void {
  assert(!result.ok, `expected a ${reason} refusal`);
  assertEquals(result.reason, reason);
  if (opIndex !== undefined) assertEquals(result.opIndex, opIndex);
}

Deno.test("checkCommitBindings: a well-formed data save passes", async () => {
  assert(checkCommitBindings(modelPartition(), await save()).ok);
});

Deno.test("checkCommitBindings: a lease op is refused", async () => {
  const ops = [...await save(), leaseOp({ holder: "me", fence: 9 })];
  assertRefused(checkCommitBindings(modelPartition(), ops), "lease-op", 3);
});

Deno.test("checkCommitBindings: an intent of another partition is refused", async () => {
  const other = partitionOf({ kind: "model", type: MODEL_TYPE, id: OTHER_ID });
  assertRefused(
    checkCommitBindings(other, await save()),
    "intent-partition-mismatch",
    0,
  );
});

Deno.test("checkCommitBindings: a key outside the intent's aggregate is refused", async () => {
  // A data save on one behavior writing a grant's data.
  const ops = [
    await putOp({
      intent: modelIntent({ kind: "data.save", name: "vpc", version: 1 }),
      key: RecordKey.create(`data/@swamp/grant/${MODEL_ID}/grant-main/1/raw`),
      inline: base64("x"),
    }),
  ];
  assertRefused(
    checkCommitBindings(modelPartition(), ops),
    "key-outside-aggregate",
    0,
  );
});

Deno.test("checkCommitBindings: an intent riding an op kind it may not ride is refused", () => {
  const ops = [
    tombstoneOp({
      intent: modelIntent({ kind: "data.save", name: "vpc", version: 1 }),
      key: RecordKey.create(`${DATA}/vpc/1/raw`),
    }),
  ];
  assertRefused(
    checkCommitBindings(modelPartition(), ops),
    "op-kind-not-allowed",
    0,
  );
});

Deno.test("checkCommitBindings: a data-version op with no put of its version is refused", async () => {
  const ops = await save();
  // The version op alone, its puts dropped.
  assertRefused(
    checkCommitBindings(modelPartition(), [ops[2]]),
    "data-version-unpaired",
    0,
  );
  // A version op whose metadata names another version than its key.
  const lying = dataVersionOp({
    key: RecordKey.create(`${DATA}/vpc/1/metadata.yaml`),
    metadata: metadata("vpc", 2),
  });
  assertRefused(
    checkCommitBindings(modelPartition(), [ops[0], ops[1], lying]),
    "data-version-unpaired",
    2,
  );
});

Deno.test("checkCommitBindings: a behavior definition's ops must agree on the type their keys name", async () => {
  const partition = partitionOf({
    kind: "config",
    definitionKind: "model",
    name: "web",
  });
  const intent = createIntent({
    kind: "definition.edit",
    definition: { kind: "model", name: "web" },
  });
  const ops = [
    await putOp({
      intent,
      key: RecordKey.create("config/models/@swamp/aws-ec2/web.yaml"),
      inline: base64("a"),
    }),
    tombstoneOp({
      intent,
      key: RecordKey.create(`config/models/@swamp/grant/${MODEL_ID}.yaml`),
    }),
  ];
  assertRefused(
    checkCommitBindings(partition, ops),
    "definition-type-mismatch",
    1,
  );
});

Deno.test("authorizeCommit: a data save needs run on the behavior, by name, as a method run does", async () => {
  const resolver = new FakeResolver();
  resolver.definitions.set(MODEL_ID, web());
  const denied = new FakeAuthority([]);
  assertRefused(
    await authorizeCommit(modelPartition(), await save(), resolver, denied),
    "forbidden",
    0,
  );
  assertEquals(denied.asked[0].action, "run");
  assertEquals(denied.asked[0].resource.kind, "model");
  assertEquals(denied.asked[0].resource.name, "web");
  assertEquals(denied.asked[0].resource.fields.tags, { team: "infra" });
  // Write on the behavior is not run: it edits the definition only.
  assertRefused(
    await authorizeCommit(
      modelPartition(),
      await save(),
      resolver,
      new FakeAuthority(["write model:web"]),
    ),
    "forbidden",
    0,
  );
  const allowed = new FakeAuthority(["run model:web", "admin access:*"]);
  assert(
    (await authorizeCommit(modelPartition(), await save(), resolver, allowed))
      .ok,
  );
  // Both puts share one intent, so the caller is asked once for each
  // access: run on the behavior, and admin.
  assertEquals(allowed.asked.length, 2);
});

Deno.test("authorizeCommit: a grant record written as plain data needs admin, and a non-admin is refused", async () => {
  const grantType = ModelType.create("@swamp/grant");
  const partition = partitionOf({
    kind: "model",
    type: grantType,
    id: MODEL_ID,
  });
  const intent = createIntent({
    kind: "data.save",
    model: modelRef(grantType, MODEL_ID),
    name: "grant-main",
    version: 1,
  });
  const ops = [
    await putOp({
      intent,
      key: RecordKey.create(`data/@swamp/grant/${MODEL_ID}/grant-main/1/raw`),
      inline: base64("{}"),
    }),
  ];
  const resolver = new FakeResolver();
  const writer = new FakeAuthority(["write model:*", "write data:*"]);
  assertRefused(
    await authorizeCommit(partition, ops, resolver, writer),
    "forbidden",
  );
  assertEquals(writer.asked[0].action, "admin");
  assertEquals(writer.asked[0].resource.kind, "access");
  assertEquals(writer.asked[0].resource.name, "swamp/grant");
  assert(
    (await authorizeCommit(partition, ops, resolver, new FakeAuthority(["*"])))
      .ok,
  );
});

Deno.test("authorizeCommit: a restricted behavior type needs admin", async () => {
  const resolver = new FakeResolver();
  resolver.restricted.add(MODEL_TYPE.normalized);
  const authority = new FakeAuthority(["write model:*"]);
  assertRefused(
    await authorizeCommit(modelPartition(), await save(), resolver, authority),
    "forbidden",
  );
  assertEquals(authority.asked[0].action, "admin");
});

Deno.test("authorizeCommit: a key another aggregate owns is refused, and a removed one may be put", async () => {
  const resolver = new FakeResolver();
  resolver.owners.set(`${DATA}/vpc/1/raw`, {
    owner: "model--other",
    present: true,
  });
  const authority = new FakeAuthority(["*"]);
  assertRefused(
    await authorizeCommit(modelPartition(), await save(), resolver, authority),
    "key-owned-elsewhere",
    0,
  );
  resolver.owners.set(`${DATA}/vpc/1/raw`, {
    owner: "model--other",
    present: false,
  });
  assert(
    (await authorizeCommit(modelPartition(), await save(), resolver, authority))
      .ok,
  );
});

Deno.test("authorizeCommit: a definition rename may write the key its old name owns", async () => {
  const oldName = partitionOf({
    kind: "config",
    definitionKind: "workflow",
    name: "old",
  });
  const newName = partitionOf({
    kind: "config",
    definitionKind: "workflow",
    name: "new",
  });
  const key = `config/workflows/workflow-${MODEL_ID}.yaml`;
  const resolver = new FakeResolver();
  resolver.owners.set(key, { owner: oldName.toString(), present: true });
  const put = await putOp({
    intent: createIntent({
      kind: "definition.rename-to",
      definition: { kind: "workflow", name: "new" },
      from: "old",
    }),
    key: RecordKey.create(key),
    inline: base64("w"),
    expect: "absent",
  });
  const authority = new FakeAuthority(["*"]);
  assert((await authorizeCommit(newName, [put], resolver, authority)).ok);
  // The same put under a plain create is another aggregate's key.
  const create = await putOp({
    intent: createIntent({
      kind: "definition.create",
      definition: { kind: "workflow", name: "new" },
    }),
    key: RecordKey.create(key),
    inline: base64("w"),
  });
  assertRefused(
    await authorizeCommit(newName, [create], resolver, authority),
    "key-owned-elsewhere",
  );
});

Deno.test("writeAccessOf: every intent kind maps to an action and resource", async () => {
  const resolver = new FakeResolver();
  for (const kind of INTENT_KINDS) {
    const intent = sampleIntent(kind);
    const op = await opFor(intent);
    if (op === undefined) continue;
    const required = await writeAccessOf(op, resolver);
    const expected = expectedWrite(intent, op.kind);
    assertEquals(
      `${required.action} ${required.resource.kind}`,
      expected,
      kind,
    );
  }
});

Deno.test("readAccessOf: data reads are data reads, and control-plane records need admin", async () => {
  const resolver = new FakeResolver();
  const [put] = await save();
  const read = await readAccessOf(put, resolver);
  assertEquals(read?.action, "read");
  assertEquals(read?.resource.kind, "data");
  const output = await putOp({
    intent: modelIntent({ kind: "output.save", outputId: "o" }),
    key: RecordKey.create(`outputs/${MODEL_TYPE.normalized}/create/o.yaml`),
    inline: base64("o"),
  });
  assertEquals((await readAccessOf(output, resolver))?.resource.kind, "model");
  const grant = await opFor(sampleIntent("grant.create"));
  assertEquals((await readAccessOf(grant as Op, resolver))?.action, "admin");
  const lockfile = await opFor(sampleIntent("lockfile.write"));
  assertEquals(await readAccessOf(lockfile as Op, resolver), undefined);
});

/** A put or tombstone of `intent` at a key its aggregate owns. */
async function opFor(intent: Intent): Promise<PutOp | TombstoneOp | undefined> {
  const key = keyFor(intent);
  for (const kind of ["put", "tombstone"] as const) {
    if (!bindKey(intent, kind, RecordKey.create(key)).ok) continue;
    return kind === "put"
      ? await putOp({ intent, key: RecordKey.create(key), inline: base64("x") })
      : tombstoneOp({ intent, key: RecordKey.create(key) });
  }
  return undefined;
}

function keyFor(intent: Intent): string {
  if ("model" in intent) {
    const type = intent.model.type;
    if (intent.kind.startsWith("output.")) {
      return `outputs/${type}/m/${MODEL_ID}-2026-01-01T00-00-00-000Z.yaml`;
    }
    if (intent.kind.startsWith("evaluated-definition.")) {
      return `definitions-evaluated/${type}/${MODEL_ID}.yaml`;
    }
    const name = "name" in intent ? intent.name : "main";
    const version = "version" in intent && intent.version !== undefined
      ? `${intent.version}/raw`
      : "latest";
    return `data/${type}/${MODEL_ID}/${name}/${version}`;
  }
  if ("run" in intent) {
    return intent.kind.startsWith("run-snapshot.")
      ? `workflows-evaluated/runs/${SAMPLE_RUN_ID}/evaluated-workflow.yaml`
      : `workflow-runs/${SAMPLE_WORKFLOW_ID}/workflow-run-${SAMPLE_RUN_ID}.yaml`;
  }
  if ("definition" in intent) {
    if (intent.kind.startsWith("evaluated-workflow.")) {
      return `workflows-evaluated/workflow-${intent.definition.name}.yaml`;
    }
    return `config/models/${MODEL_TYPE.normalized}/${intent.definition.name}.yaml`;
  }
  if ("autoDefinition" in intent) {
    return `auto-definitions/${MODEL_TYPE.normalized}/${MODEL_ID}.yaml`;
  }
  return LOCKFILE_RECORD_KEY;
}

/** Puts serve checks the content of, which need admin for now. */
const CONTENT_PUTS = [
  "definition.create",
  "definition.edit",
  "definition.rename-to",
  "evaluated-workflow.save",
  "evaluated-definition.save",
  "auto-definition.save",
  "run-snapshot.save",
];

function expectedWrite(intent: Intent, opKind: string): string {
  if (opKind === "put" && CONTENT_PUTS.includes(intent.kind)) {
    return "admin access";
  }
  if ("model" in intent) {
    if (intent.model.type !== MODEL_TYPE.normalized) return "admin access";
    switch (intent.kind) {
      case "data.save":
      case "data.append":
      case "output.save":
        return "run model";
      case "data.delete":
      case "data.rename":
      case "data.gc":
        return "write data";
      default:
        return "write model";
    }
  }
  if ("run" in intent) {
    return intent.kind.endsWith(".delete") ? "write workflow" : "run workflow";
  }
  if ("definition" in intent) {
    return intent.definition.kind === "workflow"
      ? "write workflow"
      : "write model";
  }
  if ("autoDefinition" in intent) {
    return intent.kind === "auto-definition.delete"
      ? "write model"
      : "run model";
  }
  return "admin access";
}

Deno.test("authorizeCommit: a rename-from naming another definition as its counterpart needs write on that definition too", async () => {
  const mine = partitionOf({
    kind: "config",
    definitionKind: "workflow",
    name: "mine",
  });
  const victim = partitionOf({
    kind: "config",
    definitionKind: "workflow",
    name: "victim",
  });
  const key = "config/workflows/workflow-victim.yaml";
  const resolver = new FakeResolver();
  resolver.owners.set(key, { owner: victim.toString(), present: true });
  // Tombstoning the victim's file under a rename-from of `mine`.
  const tombstone = tombstoneOp({
    intent: createIntent({
      kind: "definition.rename-from",
      definition: { kind: "workflow", name: "mine" },
      to: "victim",
    }),
    key: RecordKey.create(key),
    expect: "present",
  });
  const onlyMine = new FakeAuthority(["write workflow:mine"]);
  const refused = await authorizeCommit(mine, [tombstone], resolver, onlyMine);
  assertRefused(refused, "forbidden", 0);
  assert(!refused.ok && refused.message.includes("workflow:victim"));
  const both = new FakeAuthority([
    "write workflow:mine",
    "write workflow:victim",
    "admin access:*",
  ]);
  assert((await authorizeCommit(mine, [tombstone], resolver, both)).ok);
});

Deno.test("authorizeCommit: a vault config put needs admin, whatever the vault its content names", async () => {
  const dev = partitionOf({
    kind: "config",
    definitionKind: "vault",
    name: "dev",
  });
  const resolver = new FakeResolver();
  // A fresh uuid nobody owns, whose content names another vault.
  const create = await putOp({
    intent: createIntent({
      kind: "definition.create",
      definition: { kind: "vault", name: "dev" },
    }),
    key: RecordKey.create(
      "config/vaults/local_encryption/00000000-0000-4000-8000-000000000000.yaml",
    ),
    inline: base64("name: prod\ntype: local_encryption\n"),
    expect: "absent",
  });
  // And a rename-to over the other vault's own file.
  const prodKey = `config/vaults/local_encryption/${OTHER_ID}.yaml`;
  resolver.owners.set(prodKey, {
    owner: partitionOf({
      kind: "config",
      definitionKind: "vault",
      name: "prod",
    })
      .toString(),
    present: true,
  });
  const rename = await putOp({
    intent: createIntent({
      kind: "definition.rename-to",
      definition: { kind: "vault", name: "dev" },
      from: "prod",
    }),
    key: RecordKey.create(prodKey),
    inline: base64("type: attacker"),
    expect: "absent",
  });
  const writers = new FakeAuthority(["write vault:dev", "write vault:prod"]);
  for (const put of [create, rename]) {
    assertRefused(
      await authorizeCommit(dev, [put], resolver, writers),
      "forbidden",
      0,
    );
    assert(
      (await authorizeCommit(dev, [put], resolver, new FakeAuthority(["*"])))
        .ok,
    );
  }
});

Deno.test("authorizeCommit: a data delete or rename needs write on the behavior's data, not the behavior", async () => {
  const resolver = new FakeResolver();
  resolver.definitions.set(MODEL_ID, web());
  const remove = tombstoneOp({
    intent: modelIntent({ kind: "data.delete", name: "vpc", version: 1 }),
    key: RecordKey.create(`${DATA}/vpc/1/raw`),
  });
  const rename = await putOp({
    intent: modelIntent({ kind: "data.rename", name: "vpc", to: "net" }),
    key: RecordKey.create(`${DATA}/net/latest`),
    inline: base64("1"),
  });
  for (const op of [remove, rename]) {
    // Write on the behavior lets a caller edit it, not destroy its data.
    assertRefused(
      await authorizeCommit(
        modelPartition(),
        [op],
        resolver,
        new FakeAuthority(["write model:*", "run model:*"]),
      ),
      "forbidden",
      0,
    );
    const writer = new FakeAuthority(["write data:web", "admin access:*"]);
    assert(
      (await authorizeCommit(modelPartition(), [op], resolver, writer)).ok,
    );
    assertEquals(writer.asked[0].resource.kind, "data");
  }
});

Deno.test("authorizeCommit: data garbage collection needs write on all data, decided for the whole kind", async () => {
  const gc = tombstoneOp({
    intent: modelIntent({ kind: "data.gc", name: "vpc", version: 1 }),
    key: RecordKey.create(`${DATA}/vpc/1/raw`),
  });
  const authority = new FakeAuthority(["write data:*", "admin access:*"]);
  assert(
    (await authorizeCommit(
      modelPartition(),
      [gc],
      new FakeResolver(),
      authority,
    ))
      .ok,
  );
  assertEquals(authority.asked[0].every, true);
  assertEquals(authority.asked[0].resource.name, "*");
  assertRefused(
    await authorizeCommit(
      modelPartition(),
      [gc],
      new FakeResolver(),
      new FakeAuthority(["write data:web", "write model:*"]),
    ),
    "forbidden",
    0,
  );
});

Deno.test("authorizeCommit: every forwarded write needs admin until swamp-club#3922, whatever else the caller holds", async () => {
  const resolver = new FakeResolver();
  resolver.definitions.set(MODEL_ID, web());
  const member = new FakeAuthority([
    "run model:*",
    "write model:*",
    "write data:*",
  ]);
  const refused = await authorizeCommit(
    modelPartition(),
    await save(),
    resolver,
    member,
  );
  assertRefused(refused, "forbidden", 0);
  assert(!refused.ok && refused.message.includes("admin access:*"));
});
