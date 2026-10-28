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
  baseRecordReadAccessOf,
  type CallerAuthority,
  checkCommitBindings,
  type CommitAuthorization,
  type ContentAuthority,
  definitionRecordReadAccessOf,
  type KeyOwnership,
  partitionWriteAccessOf,
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

/** A content check that allows every put: these tests decide base access. */
const PASSES: ContentAuthority = { check: () => Promise.resolve(undefined) };

/** {@link authorizeCommit} with every put's content allowed. */
function authorizeBase(
  partition: Parameters<typeof authorizeCommit>[0],
  ops: readonly Op[],
  resolver: AggregateResourceResolver,
  authority: CallerAuthority,
): Promise<CommitAuthorization> {
  return authorizeCommit(partition, ops, resolver, authority, PASSES);
}
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
    await authorizeBase(modelPartition(), await save(), resolver, denied),
    "forbidden",
    0,
  );
  assertEquals(denied.asked[0].action, "run");
  assertEquals(denied.asked[0].resource.kind, "model");
  assertEquals(denied.asked[0].resource.name, "web");
  assertEquals(denied.asked[0].resource.fields.tags, { team: "infra" });
  // Write on the behavior is not run: it edits the definition only.
  assertRefused(
    await authorizeBase(
      modelPartition(),
      await save(),
      resolver,
      new FakeAuthority(["write model:web"]),
    ),
    "forbidden",
    0,
  );
  // Run alone is enough: a forwarded write needs no admin (swamp-club#3922).
  const allowed = new FakeAuthority(["run model:web"]);
  assert(
    (await authorizeBase(modelPartition(), await save(), resolver, allowed))
      .ok,
  );
  // Both puts share one intent, so the caller is asked once.
  assertEquals(allowed.asked.length, 1);
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
    await authorizeBase(partition, ops, resolver, writer),
    "forbidden",
  );
  assertEquals(writer.asked[0].action, "admin");
  assertEquals(writer.asked[0].resource.kind, "access");
  assertEquals(writer.asked[0].resource.name, "swamp/grant");
  assert(
    (await authorizeBase(partition, ops, resolver, new FakeAuthority(["*"])))
      .ok,
  );
});

Deno.test("authorizeCommit: a restricted behavior type needs admin", async () => {
  const resolver = new FakeResolver();
  resolver.restricted.add(MODEL_TYPE.normalized);
  const authority = new FakeAuthority(["write model:*"]);
  assertRefused(
    await authorizeBase(modelPartition(), await save(), resolver, authority),
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
    await authorizeBase(modelPartition(), await save(), resolver, authority),
    "key-owned-elsewhere",
    0,
  );
  resolver.owners.set(`${DATA}/vpc/1/raw`, {
    owner: "model--other",
    present: false,
  });
  assert(
    (await authorizeBase(modelPartition(), await save(), resolver, authority))
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
  assert((await authorizeBase(newName, [put], resolver, authority)).ok);
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
    await authorizeBase(newName, [create], resolver, authority),
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

function expectedWrite(intent: Intent, _opKind: string): string {
  if ("model" in intent) {
    if (intent.model.type !== MODEL_TYPE.normalized) return "admin access";
    switch (intent.kind) {
      case "data.save":
      case "data.append":
      case "output.save":
      case "evaluated-definition.save":
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
    if (intent.kind === "evaluated-workflow.save") return "run workflow";
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
  const refused = await authorizeBase(mine, [tombstone], resolver, onlyMine);
  assertRefused(refused, "forbidden", 0);
  assert(!refused.ok && refused.message.includes("workflow:victim"));
  const both = new FakeAuthority([
    "write workflow:mine",
    "write workflow:victim",
  ]);
  assert((await authorizeBase(mine, [tombstone], resolver, both)).ok);
});

Deno.test("authorizeCommit: a vault config put needs write on the vault, and a vault config removal needs admin", async () => {
  const dev = partitionOf({
    kind: "config",
    definitionKind: "vault",
    name: "dev",
  });
  const resolver = new FakeResolver();
  const key =
    "config/vaults/local_encryption/00000000-0000-4000-8000-000000000000.yaml";
  const create = await putOp({
    intent: createIntent({
      kind: "definition.create",
      definition: { kind: "vault", name: "dev" },
    }),
    key: RecordKey.create(key),
    inline: base64("name: dev\ntype: local_encryption\n"),
    expect: "absent",
  });
  const writer = new FakeAuthority(["write vault:dev"]);
  assert((await authorizeBase(dev, [create], resolver, writer)).ok);
  assertRefused(
    await authorizeBase(dev, [create], resolver, new FakeAuthority([])),
    "forbidden",
    0,
  );
  // Serve's API never removes a vault config: a delete needs admin.
  const remove = tombstoneOp({
    intent: createIntent({
      kind: "definition.delete",
      definition: { kind: "vault", name: "dev" },
    }),
    key: RecordKey.create(key),
  });
  resolver.owners.set(key, { owner: dev.toString(), present: true });
  assertRefused(
    await authorizeBase(dev, [remove], resolver, writer),
    "forbidden",
    0,
  );
  assert(
    (await authorizeBase(dev, [remove], resolver, new FakeAuthority(["*"])))
      .ok,
  );
});

Deno.test("authorizeCommit: a vault rename's removal lands only once its rename-to owns the key", async () => {
  const prod = partitionOf({
    kind: "config",
    definitionKind: "vault",
    name: "prod",
  });
  const key = `config/vaults/local_encryption/${OTHER_ID}.yaml`;
  const resolver = new FakeResolver();
  const removal = tombstoneOp({
    intent: createIntent({
      kind: "definition.rename-from",
      definition: { kind: "vault", name: "prod" },
      to: "staging",
    }),
    key: RecordKey.create(key),
  });
  const writer = new FakeAuthority(["write vault:prod", "write vault:staging"]);
  // The key is still the old name's: the rename-to has not landed.
  resolver.owners.set(key, { owner: prod.toString(), present: true });
  assertRefused(
    await authorizeBase(prod, [removal], resolver, writer),
    "forbidden",
    0,
  );
  resolver.owners.set(key, {
    owner: partitionOf({
      kind: "config",
      definitionKind: "vault",
      name: "staging",
    }).toString(),
    present: true,
  });
  assert((await authorizeBase(prod, [removal], resolver, writer)).ok);
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
      await authorizeBase(
        modelPartition(),
        [op],
        resolver,
        new FakeAuthority(["write model:*", "run model:*"]),
      ),
      "forbidden",
      0,
    );
    const writer = new FakeAuthority(["write data:web"]);
    assert(
      (await authorizeBase(modelPartition(), [op], resolver, writer)).ok,
    );
    assertEquals(writer.asked[0].resource.kind, "data");
  }
});

Deno.test("authorizeCommit: data garbage collection needs write on all data, decided for the whole kind", async () => {
  const gc = tombstoneOp({
    intent: modelIntent({ kind: "data.gc", name: "vpc", version: 1 }),
    key: RecordKey.create(`${DATA}/vpc/1/raw`),
  });
  const authority = new FakeAuthority(["write data:*"]);
  assert(
    (await authorizeBase(
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
    await authorizeBase(
      modelPartition(),
      [gc],
      new FakeResolver(),
      new FakeAuthority(["write data:web", "write model:*"]),
    ),
    "forbidden",
    0,
  );
});

Deno.test("authorizeCommit: a content check refuses the commit at the put it refuses, and only runs when content is given", async () => {
  const resolver = new FakeResolver();
  resolver.definitions.set(MODEL_ID, web());
  const runner = new FakeAuthority(["run model:web"]);
  const ops = await save();
  const checked: number[] = [];
  const refusing: ContentAuthority = {
    check: (op, commit) => {
      checked.push(commit.indexOf(op));
      return Promise.resolve(
        op.key.toString().endsWith("metadata.yaml")
          ? { message: "names a vault reference the caller may not read" }
          : undefined,
      );
    },
  };
  const refused = await authorizeCommit(
    modelPartition(),
    ops,
    resolver,
    runner,
    refusing,
  );
  assertRefused(refused, "content-refused", 1);
  assertEquals(checked, [0, 1]);
  // Deferred: the pass before content arrives decides access alone.
  checked.length = 0;
  assert(
    (await authorizeCommit(
      modelPartition(),
      ops,
      resolver,
      runner,
      "deferred",
    )).ok,
  );
  assertEquals(checked, []);
});

Deno.test("authorizeCommit: content is checked only after access, so a caller without access learns nothing from it", async () => {
  const resolver = new FakeResolver();
  resolver.definitions.set(MODEL_ID, web());
  let checks = 0;
  const counting: ContentAuthority = {
    check: () => {
      checks++;
      return Promise.resolve(undefined);
    },
  };
  assertRefused(
    await authorizeCommit(
      modelPartition(),
      await save(),
      resolver,
      new FakeAuthority([]),
      counting,
    ),
    "forbidden",
    0,
  );
  assertEquals(checks, 0);
});

Deno.test("definitionRecordReadAccessOf: decides a definition record by the type its key names", async () => {
  const resolver = new FakeResolver();
  resolver.restricted.add("acme/locked");
  const access = (key: string) =>
    definitionRecordReadAccessOf("shared", RecordKey.create(key), resolver);

  const ordinary = await access("config/models/acme/web/shared.yaml");
  assertEquals(ordinary.action, "read");
  assertEquals(ordinary.resource.kind, "model");
  assertEquals(ordinary.resource.name, "shared");

  // A control-plane type, a restricted one, or a key naming no type the
  // partition's definition could own, needs admin.
  for (
    const key of [
      "config/models/@swamp/grant/shared.yaml",
      "config/models/acme/locked/shared.yaml",
      "config/models/acme/web/other.yaml",
    ]
  ) {
    assertEquals((await access(key)).action, "admin", key);
  }
});

Deno.test("baseRecordReadAccessOf: decides a compacted record by its partition and key, as the feed decides the op that wrote it", async () => {
  const resolver = new FakeResolver();
  resolver.definitions.set(MODEL_ID, web());
  resolver.workflows.set(SAMPLE_WORKFLOW_ID, { name: "deploy" });
  const decided = async (
    partition: Parameters<typeof baseRecordReadAccessOf>[0],
    key: string,
  ) =>
    (await baseRecordReadAccessOf(partition, RecordKey.create(key), resolver))
      .map(({ action, resource }) =>
        `${action} ${resource.kind}:${resource.name}`
      );
  const model = modelPartition();

  assertEquals(await decided(model, `${DATA}/vpc/1/raw`), ["read data:web"]);
  assertEquals(await decided(model, `${DATA}/vpc/latest`), ["read data:web"]);
  assertEquals(
    await decided(
      model,
      `outputs/${MODEL_TYPE.normalized}/create/${MODEL_ID}-2026-01-01T00-00-00-000Z.yaml`,
    ),
    ["read model:web"],
  );
  assertEquals(
    await decided(
      model,
      `definitions-evaluated/${MODEL_TYPE.normalized}/${MODEL_ID}.yaml`,
    ),
    ["read model:web"],
  );
  // A key no intent of the behavior writes says nothing of what it holds:
  // admin, and both reads, so it is never shown more loosely than any op.
  assertEquals(await decided(model, `${DATA}/vpc/1/other`), [
    "admin access:*",
    "read data:web",
    "read model:web",
  ]);
  // Another behavior's data key in this partition is not this one's data.
  assertEquals(
    (await decided(
      model,
      `data/${MODEL_TYPE.normalized}/${OTHER_ID}/vpc/1/raw`,
    ))[0],
    "admin access:*",
  );

  const grant = partitionOf({
    kind: "model",
    type: ModelType.create("@swamp/grant"),
    id: MODEL_ID,
  });
  assertEquals(
    (await decided(grant, `data/@swamp/grant/${MODEL_ID}/main/1/raw`))
      .map((access) => access.split(" ")[0]),
    ["admin"],
  );

  const run = partitionOf({
    kind: "run",
    workflowId: SAMPLE_WORKFLOW_ID,
    runId: SAMPLE_RUN_ID,
  });
  assertEquals(
    await decided(
      run,
      `workflow-runs/${SAMPLE_WORKFLOW_ID}/workflow-run-${SAMPLE_RUN_ID}.yaml`,
    ),
    ["read workflow:deploy"],
  );

  // A definition's config partition decides each record by the type its
  // key names, so same-named definitions sharing it are told apart
  // (swamp-club#3938).
  const shared = partitionOf({
    kind: "config",
    definitionKind: "model",
    name: "shared",
  });
  assertEquals(
    await decided(shared, "config/models/acme/web/shared.yaml"),
    ["read model:shared"],
  );
  assertEquals(
    (await decided(shared, "config/models/@swamp/grant/shared.yaml"))[0]
      .split(" ")[0],
    "admin",
  );

  const auto = partitionOf({ kind: "definition", id: MODEL_ID });
  assertEquals(
    await decided(
      auto,
      `auto-definitions/${MODEL_TYPE.normalized}/${MODEL_ID}.yaml`,
    ),
    [`read model:${MODEL_ID}`],
  );
  assertEquals(
    (await decided(auto, `auto-definitions/@swamp/grant/${MODEL_ID}.yaml`))[0]
      .split(" ")[0],
    "admin",
  );

  assertEquals(
    await decided(partitionOf({ kind: "lockfile" }), LOCKFILE_RECORD_KEY),
    [],
  );
});

Deno.test("partitionWriteAccessOf: an upload needs the least write a partition takes, and admin where its partition names no type", async () => {
  const resolver = new FakeResolver();
  resolver.definitions.set(MODEL_ID, web());
  resolver.workflows.set(SAMPLE_WORKFLOW_ID, { name: "deploy" });
  const decided = async (
    partition: Parameters<typeof partitionWriteAccessOf>[0],
  ) => {
    const { action, resource } = await partitionWriteAccessOf(
      partition,
      resolver,
    );
    return `${action} ${resource.kind}:${resource.name}`;
  };
  assertEquals(await decided(modelPartition()), "run model:web");
  assertEquals(
    await decided(
      partitionOf({
        kind: "run",
        workflowId: SAMPLE_WORKFLOW_ID,
        runId: SAMPLE_RUN_ID,
      }),
    ),
    "run workflow:deploy",
  );
  assertEquals(
    await decided(
      partitionOf({
        kind: "config",
        definitionKind: "workflow",
        name: "deploy",
      }),
    ),
    "write workflow:deploy",
  );
  assertEquals(
    await decided(
      partitionOf({ kind: "config", definitionKind: "vault", name: "dev" }),
    ),
    "write vault:dev",
  );
  for (
    const partition of [
      partitionOf({ kind: "config", definitionKind: "model", name: "web" }),
      partitionOf({ kind: "definition", id: MODEL_ID }),
      partitionOf({ kind: "lockfile" }),
      partitionOf({
        kind: "model",
        type: ModelType.create("@swamp/grant"),
        id: MODEL_ID,
      }),
    ]
  ) {
    assert(
      (await decided(partition)).startsWith("admin "),
      partition.toString(),
    );
  }
  resolver.restricted.add(MODEL_TYPE.normalized);
  assertEquals(await decided(modelPartition()), "admin access:*");
});
