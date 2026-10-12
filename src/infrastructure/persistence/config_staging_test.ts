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

import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { TypedChange } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { recordKeyOf } from "../../domain/datastore_v3/repository_changes.ts";
import {
  definitionDeleteBatches,
  definitionSaveBatches,
  keyUnder,
  type PriorFile,
  readPriorFile,
  type StagingTier,
  stagingTierOf,
} from "./config_staging.ts";
import { registerManagedConfig } from "./paths.ts";

const ID = "3f0e7d1c-2b4a-4c6d-8e9f-0a1b2c3d4e5f";
const CONTENT = new TextEncoder().encode("name: x\n");

/** Fake files: path → tier key, so the builders never touch a filesystem. */
const TIERS: Record<string, StagingTier> = {
  "/c/vpc.yaml": config("config/models/t/vpc.yaml"),
  "/c/net.yaml": config("config/models/t/net.yaml"),
  [`/c/${ID}.yaml`]: config(`config/models/t/${ID}.yaml`),
  "/a/vpc.yaml": auto("auto-definitions/t/vpc.yaml"),
  "/a/net.yaml": auto("auto-definitions/t/net.yaml"),
};

function config(key: string): StagingTier {
  return { tier: "config", key: recordKeyOf(key.split("/")) };
}

function auto(key: string): StagingTier {
  return { tier: "auto", key: recordKeyOf(key.split("/")) };
}

function prior(name: string | undefined, sha = "a".repeat(64)): PriorFile {
  return {
    bytes: new Uint8Array(),
    sha256: sha,
    ...(name === undefined ? {} : { name }),
  };
}

/** Each batch as [partition, kind, intent kind, key, expect] rows. */
function rows(batches: TypedChange[][]): unknown[][][] {
  return batches.map((batch) =>
    batch.map((change) => {
      if ("put" in change) {
        return [
          change.partition.toString(),
          "put",
          change.put.intent.kind,
          change.put.key.toString(),
          change.put.expect ?? null,
        ];
      }
      const op = change.op;
      if (op.kind !== "tombstone") throw new Error(`unexpected ${op.kind}`);
      return [
        change.partition.toString(),
        "tombstone",
        op.intent.kind,
        op.key.toString(),
        op.expect ?? null,
      ];
    })
  );
}

function save(
  name: string,
  targetPath: string,
  removed: string[] = [],
  priors: Record<string, PriorFile> = {},
) {
  return rows(definitionSaveBatches({
    kind: "model",
    id: ID,
    name,
    targetPath,
    content: CONTENT,
    removed,
    priors: new Map(Object.entries(priors)),
    tierOf: (path) => TIERS[path],
  }));
}

Deno.test("definitionSaveBatches: a new definition is a create expecting its key absent", () => {
  assertEquals(save("vpc", "/c/vpc.yaml"), [[
    [
      "config--model--vpc",
      "put",
      "definition.create",
      "config/models/t/vpc.yaml",
      "absent",
    ],
  ]]);
});

Deno.test("definitionSaveBatches: an edit expects the replaced bytes, or nothing when their name is unreadable", () => {
  assertEquals(
    save("vpc", "/c/vpc.yaml", [], {
      "/c/vpc.yaml": prior("vpc", "b".repeat(64)),
    }),
    [[[
      "config--model--vpc",
      "put",
      "definition.edit",
      "config/models/t/vpc.yaml",
      { sha256: "b".repeat(64) },
    ]]],
  );
  assertEquals(
    save("vpc", "/c/vpc.yaml", [], {
      "/c/vpc.yaml": prior(undefined),
    })[0][0][4],
    null,
  );
});

Deno.test("definitionSaveBatches: a move from a legacy key of the same name is one batch", () => {
  assertEquals(
    save("vpc", "/c/vpc.yaml", [`/c/${ID}.yaml`], {
      [`/c/${ID}.yaml`]: prior("vpc"),
    }),
    [[
      [
        "config--model--vpc",
        "put",
        "definition.edit",
        "config/models/t/vpc.yaml",
        "absent",
      ],
      [
        "config--model--vpc",
        "tombstone",
        "definition.edit",
        `config/models/t/${ID}.yaml`,
        "present",
      ],
    ]],
  );
});

Deno.test("definitionSaveBatches: a rename puts under the new name, then tombstones the old in a later batch", () => {
  assertEquals(
    save("net", "/c/net.yaml", ["/c/vpc.yaml"], {
      "/c/vpc.yaml": prior("vpc"),
    }),
    [
      [[
        "config--model--net",
        "put",
        "definition.rename-to",
        "config/models/t/net.yaml",
        "absent",
      ]],
      [[
        "config--model--vpc",
        "tombstone",
        "definition.rename-from",
        "config/models/t/vpc.yaml",
        "present",
      ]],
    ],
  );
});

Deno.test("definitionSaveBatches: a same-key rename tombstones the target key in the old name's partition", () => {
  const key = `config/models/t/${ID}.yaml`;
  assertEquals(
    save("@team/net", `/c/${ID}.yaml`, [], {
      [`/c/${ID}.yaml`]: prior("@team/vpc"),
    }),
    [
      [[
        "config--model--@team%2Fnet",
        "put",
        "definition.rename-to",
        key,
        "absent",
      ]],
      [[
        "config--model--@team%2Fvpc",
        "tombstone",
        "definition.rename-from",
        key,
        "present",
      ]],
    ],
  );
});

Deno.test("definitionSaveBatches: a target that already holds this name is an edit, though a removed copy declared another", () => {
  const batches = save("vpc", "/c/vpc.yaml", ["/c/net.yaml"], {
    "/c/vpc.yaml": prior("vpc", "c".repeat(64)),
    "/c/net.yaml": prior("net"),
  });
  assertEquals(batches[0], [[
    "config--model--vpc",
    "put",
    "definition.edit",
    "config/models/t/vpc.yaml",
    { sha256: "c".repeat(64) },
  ]]);
  assertEquals(batches[1], [[
    "config--model--net",
    "tombstone",
    "definition.rename-from",
    "config/models/t/net.yaml",
    "present",
  ]]);
});

Deno.test("definitionSaveBatches: an auto-definition carries no precondition, and a move across tiers tombstones the other tier", () => {
  // An auto-definition renamed in its directory: one partition, one batch.
  assertEquals(
    save("net", "/a/net.yaml", ["/a/vpc.yaml"], {
      "/a/vpc.yaml": prior("vpc"),
    }),
    [[
      [
        `definition--${ID}`,
        "put",
        "auto-definition.save",
        "auto-definitions/t/net.yaml",
        null,
      ],
      [
        `definition--${ID}`,
        "tombstone",
        "auto-definition.delete",
        "auto-definitions/t/vpc.yaml",
        null,
      ],
    ]],
  );
  // A managed-config save that removed the auto-definition file.
  assertEquals(
    save("vpc", "/c/vpc.yaml", ["/a/vpc.yaml"], {
      "/c/vpc.yaml": prior("vpc", "d".repeat(64)),
      "/a/vpc.yaml": prior("vpc"),
    }).at(-1),
    [[
      `definition--${ID}`,
      "tombstone",
      "auto-definition.delete",
      "auto-definitions/t/vpc.yaml",
      null,
    ]],
  );
  // An auto-definition save that removed a managed-config file.
  assertEquals(
    save("vpc", "/a/vpc.yaml", ["/c/vpc.yaml"], { "/c/vpc.yaml": prior("vpc") })
      .at(-1),
    [[
      "config--model--vpc",
      "tombstone",
      "definition.delete",
      "config/models/t/vpc.yaml",
      "present",
    ]],
  );
});

Deno.test("definitionSaveBatches: a git-tracked file stages nothing", () => {
  assertEquals(save("vpc", "/git/vpc.yaml", ["/git/old.yaml"]), []);
});

Deno.test("definitionDeleteBatches: one batch per partition, without preconditions; an unknown name or a git file stages nothing", () => {
  const remove = (name: string | undefined, removed: string[], priors = {}) =>
    rows(definitionDeleteBatches({
      kind: "model",
      id: ID,
      name,
      removed,
      priors: new Map(Object.entries(priors)),
      tierOf: (path) => TIERS[path],
    }));
  assertEquals(
    remove("vpc", [
      "/c/vpc.yaml",
      `/c/${ID}.yaml`,
      "/a/vpc.yaml",
      "/git/x.yaml",
    ], {
      [`/c/${ID}.yaml`]: prior("other"),
    }),
    [
      [[
        "config--model--vpc",
        "tombstone",
        "definition.delete",
        "config/models/t/vpc.yaml",
        null,
      ]],
      [[
        "config--model--other",
        "tombstone",
        "definition.delete",
        `config/models/t/${ID}.yaml`,
        null,
      ]],
      [[
        `definition--${ID}`,
        "tombstone",
        "auto-definition.delete",
        "auto-definitions/t/vpc.yaml",
        null,
      ]],
    ],
  );
  assertEquals(remove(undefined, ["/c/vpc.yaml"]), []);
});

Deno.test("definitionSaveBatches and definitionDeleteBatches: a vault config stages in config--vault--{name} (swamp-club#3257)", () => {
  const vault = (
    name: string,
    priors: Record<string, PriorFile> = {},
  ) =>
    rows(definitionSaveBatches({
      kind: "vault",
      id: ID,
      name,
      targetPath: "/c/vpc.yaml",
      content: CONTENT,
      removed: [],
      priors: new Map(Object.entries(priors)),
      tierOf: (path) => TIERS[path],
    }));
  assertEquals(vault("vpc"), [[[
    "config--vault--vpc",
    "put",
    "definition.create",
    "config/models/t/vpc.yaml",
    "absent",
  ]]]);
  // The path is by id, so a vault rename is always a same-key rename.
  assertEquals(vault("net", { "/c/vpc.yaml": prior("vpc") }), [
    [[
      "config--vault--net",
      "put",
      "definition.rename-to",
      "config/models/t/vpc.yaml",
      "absent",
    ]],
    [[
      "config--vault--vpc",
      "tombstone",
      "definition.rename-from",
      "config/models/t/vpc.yaml",
      "present",
    ]],
  ]);
  assertEquals(
    rows(definitionDeleteBatches({
      kind: "vault",
      id: ID,
      name: "vpc",
      removed: ["/c/vpc.yaml"],
      priors: new Map(),
      tierOf: (path) => TIERS[path],
    })),
    [[[
      "config--vault--vpc",
      "tombstone",
      "definition.delete",
      "config/models/t/vpc.yaml",
      null,
    ]]],
  );
});

Deno.test("stagingTierOf and keyUnder: tier and key come from the file's own directory", () => {
  const repoDir = join(Deno.cwd(), `staging-tier-${crypto.randomUUID()}`);
  const configBase = join(repoDir, ".swamp", "config");
  const autoBase = join(repoDir, ".swamp", "auto-definitions");
  assertEquals(
    stagingTierOf(repoDir, [autoBase], join(configBase, "models", "a.yaml")),
    undefined,
  );
  registerManagedConfig(repoDir, true, configBase);
  const configTier = stagingTierOf(
    repoDir,
    [],
    join(configBase, "models", "t", "a.yaml"),
  );
  assertEquals(configTier?.tier, "config");
  assertEquals(configTier?.key.toString(), "config/models/t/a.yaml");
  const autoTier = stagingTierOf(
    repoDir,
    [join(repoDir, "models"), autoBase],
    join(autoBase, "t", "b.yaml"),
  );
  assertEquals(autoTier?.tier, "auto");
  assertEquals(autoTier?.key.toString(), "auto-definitions/t/b.yaml");
  assertEquals(
    stagingTierOf(
      repoDir,
      [join(repoDir, "models")],
      join(repoDir, "models", "c.yaml"),
    ),
    undefined,
  );
  assertThrows(() =>
    keyUnder("config", configBase, join(repoDir, "elsewhere.yaml"))
  );
  assertThrows(() => keyUnder("config", configBase, configBase));
});

Deno.test("readPriorFile: reads bytes, digest and declared fields; a missing path or a directory is no file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "a.yaml");
    await Deno.writeTextFile(path, "id: x\nname: vpc\ntype: 7\n");
    const read = await readPriorFile(path);
    assertEquals(read?.id, "x");
    assertEquals(read?.name, "vpc");
    // A field that is not a string is not declared.
    assertEquals(read?.type, undefined);
    assertEquals(read?.sha256.length, 64);
    await Deno.writeTextFile(join(dir, "bad.yaml"), ": [unclosed");
    assertEquals((await readPriorFile(join(dir, "bad.yaml")))?.name, undefined);
    assertEquals(await readPriorFile(join(dir, "missing.yaml")), undefined);
    assertEquals(await readPriorFile(dir), undefined);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
