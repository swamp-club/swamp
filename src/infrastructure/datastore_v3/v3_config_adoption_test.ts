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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import { assertPathEquals } from "../persistence/path_test_helpers.ts";
import { planConfigAdoption } from "./v3_config_adoption.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "v3-config-adoption-test-" });
  try {
    return await fn(dir);
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // Windows occasionally throws EBUSY when V8 hasn't released file
      // handles. Best-effort cleanup.
    }
  }
}

async function writeFile(path: string, text: string): Promise<void> {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, text);
}

const ID_1 = "6f1d2c1e-8f4a-4c7e-9d55-0b3f3f6f0a11";
const ID_2 = "0b6f1a52-3c3e-4f19-8d0b-6f6c2f4f8e21";

Deno.test("planConfigAdoption: adopts each named file into the config tier at the same relative path", async () => {
  await withTempDir(async (repoDir) => {
    const configBase = join(repoDir, ".swamp", "config");
    await writeFile(
      join(repoDir, "models", "command", "shell", "m1.yaml"),
      `id: ${ID_1}\nname: m1\ntype: command/shell\n`,
    );
    await writeFile(
      join(repoDir, "workflows", "workflow-w1.yaml"),
      `id: ${ID_2}\nname: w1\n`,
    );
    await writeFile(
      join(repoDir, "vaults", "local_encryption", `${ID_1}.yaml`),
      `id: ${ID_1}\nname: default\ntype: local_encryption\n`,
    );
    const plan = await planConfigAdoption({
      repoDir,
      configBase,
      partitionHasCommits: () => Promise.resolve(false),
    });
    assertEquals(
      plan.adoptions.map((a) => [a.kind, a.name, a.id]),
      [["model", "m1", ID_1], ["workflow", "w1", ID_2], [
        "vault",
        "default",
        ID_1,
      ]],
    );
    assertPathEquals(
      plan.adoptions[0].targetPath,
      join(configBase, "models", "command", "shell", "m1.yaml"),
    );
    assertPathEquals(
      plan.adoptions[2].targetPath,
      join(configBase, "vaults", "local_encryption", `${ID_1}.yaml`),
    );
    assertEquals(plan.alreadyCommitted, 0);
    assertEquals(plan.skipped, []);
  });
});

Deno.test("planConfigAdoption: a name whose partition has commits is not adopted", async () => {
  await withTempDir(async (repoDir) => {
    await writeFile(
      join(repoDir, "vaults", "local_encryption", `${ID_1}.yaml`),
      `id: ${ID_1}\nname: default\ntype: local_encryption\n`,
    );
    await writeFile(
      join(repoDir, "vaults", "local_encryption", `${ID_2}.yaml`),
      `id: ${ID_2}\nname: other\ntype: local_encryption\n`,
    );
    const committed = partitionOf({
      kind: "config",
      definitionKind: "vault",
      name: "default",
    });
    const plan = await planConfigAdoption({
      repoDir,
      configBase: join(repoDir, ".swamp", "config"),
      partitionHasCommits: (partition) =>
        Promise.resolve(partition.equals(committed)),
    });
    assertEquals(plan.adoptions.map((a) => a.name), ["other"]);
    // No tier copy at its path: another checkout's, or since renamed or
    // deleted, so it is reported rather than counted as done.
    assertEquals(plan.alreadyCommitted, 0);
    assertEquals(
      plan.skipped.map((s) => [s.name, s.reason]),
      [["default", "name-committed"]],
    );
  });
});

Deno.test("planConfigAdoption: unnamed files and repeated names are skipped and reported", async () => {
  await withTempDir(async (repoDir) => {
    const first = join(repoDir, "workflows", "workflow-a.yaml");
    const second = join(repoDir, "workflows", "workflow-b.yaml");
    const unnamed = join(repoDir, "workflows", "workflow-c.yaml");
    await writeFile(first, `id: ${ID_1}\nname: same\n`);
    await writeFile(second, `id: ${ID_2}\nname: same\n`);
    await writeFile(unnamed, `id: ${ID_1}\n`);
    await writeFile(join(repoDir, "workflows", "notes.txt"), "name: ignored\n");
    const plan = await planConfigAdoption({
      repoDir,
      configBase: join(repoDir, ".swamp", "config"),
      partitionHasCommits: () => Promise.resolve(false),
    });
    assertEquals(plan.adoptions.map((a) => a.sourcePath), [first]);
    assertEquals(
      plan.skipped.map((s) => [s.path, s.name, s.reason]),
      [[second, "same", "duplicate-name"], [unnamed, undefined, "unnamed"]],
    );
  });
});

Deno.test("planConfigAdoption: symlinks are neither read nor followed", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const outside = join(dir, "outside");
    await writeFile(
      join(outside, "secret.yaml"),
      `id: ${ID_1}\nname: leaked\ntype: local_encryption\n`,
    );
    await Deno.mkdir(join(repoDir, "vaults"), { recursive: true });
    await Deno.symlink(
      join(outside, "secret.yaml"),
      join(repoDir, "vaults", "linked.yaml"),
      { type: "file" },
    );
    await Deno.symlink(outside, join(repoDir, "vaults", "linked-dir"), {
      type: "dir",
    });
    const plan = await planConfigAdoption({
      repoDir,
      configBase: join(repoDir, ".swamp", "config"),
      partitionHasCommits: () => Promise.resolve(false),
    });
    assertEquals(plan.adoptions, []);
    assertEquals(plan.skipped, []);
  });
});

Deno.test("planConfigAdoption: a repo with no config trees adopts nothing", async () => {
  await withTempDir(async (repoDir) => {
    const plan = await planConfigAdoption({
      repoDir,
      configBase: join(repoDir, ".swamp", "config"),
      partitionHasCommits: () => Promise.resolve(false),
    });
    assertEquals(plan, { adoptions: [], alreadyCommitted: 0, skipped: [] });
  });
});

Deno.test("planConfigAdoption: a file the config tier already holds, edited or not, is skipped without reading the commit log", async () => {
  await withTempDir(async (repoDir) => {
    const configBase = join(repoDir, ".swamp", "config");
    const text = `id: ${ID_1}\nname: w1\n`;
    await writeFile(join(repoDir, "workflows", "workflow-w1.yaml"), text);
    await writeFile(join(configBase, "workflows", "workflow-w1.yaml"), text);
    await writeFile(
      join(repoDir, "workflows", "workflow-w2.yaml"),
      `id: ${ID_2}\nname: w2\n`,
    );
    await writeFile(
      join(configBase, "workflows", "workflow-w2.yaml"),
      `id: ${ID_2}\nname: w2\ndescription: edited in the tier\n`,
    );
    const asked: string[] = [];
    const plan = await planConfigAdoption({
      repoDir,
      configBase,
      partitionHasCommits: (partition) => {
        asked.push(partition.toString());
        return Promise.resolve(false);
      },
    });
    assertEquals(plan.adoptions, []);
    assertEquals(plan.alreadyCommitted, 2);
    assertEquals(asked, []);
  });
});

Deno.test("planConfigAdoption: a path no record key can name is skipped, not thrown at staging", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (repoDir) => {
    const odd = join(repoDir, "workflows", "workflow-a\\b.yaml");
    await writeFile(odd, `id: ${ID_1}\nname: odd\n`);
    const plan = await planConfigAdoption({
      repoDir,
      configBase: join(repoDir, ".swamp", "config"),
      partitionHasCommits: () => Promise.resolve(false),
    });
    assertEquals(plan.adoptions, []);
    assertEquals(
      plan.skipped.map((s) => [s.path, s.reason]),
      [[odd, "invalid-path"]],
    );
  });
});

Deno.test("planConfigAdoption: a tree whose root is a symlink is not read", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const outside = join(dir, "outside");
    await writeFile(
      join(outside, "local_encryption", `${ID_1}.yaml`),
      `id: ${ID_1}\nname: leaked\ntype: local_encryption\n`,
    );
    await Deno.mkdir(repoDir, { recursive: true });
    await Deno.symlink(outside, join(repoDir, "vaults"), { type: "dir" });
    const plan = await planConfigAdoption({
      repoDir,
      configBase: join(repoDir, ".swamp", "config"),
      partitionHasCommits: () => Promise.resolve(false),
    });
    assertEquals(plan.adoptions, []);
  });
});

Deno.test("planConfigAdoption: an unreadable file or directory is reported, not thrown", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (repoDir) => {
    const file = join(repoDir, "workflows", "workflow-locked.yaml");
    await writeFile(file, `id: ${ID_1}\nname: locked\n`);
    const dir = join(repoDir, "models", "sealed");
    await writeFile(join(dir, "m.yaml"), `id: ${ID_2}\nname: m\n`);
    await Deno.chmod(file, 0o000);
    await Deno.chmod(dir, 0o000);
    try {
      const plan = await planConfigAdoption({
        repoDir,
        configBase: join(repoDir, ".swamp", "config"),
        partitionHasCommits: () => Promise.resolve(false),
      });
      assertEquals(plan.adoptions, []);
      assertEquals(
        plan.skipped.map((s) => [s.path, s.reason]).sort(),
        [[dir, "unreadable"], [file, "unreadable"]].sort(),
      );
    } finally {
      await Deno.chmod(file, 0o644);
      await Deno.chmod(dir, 0o755);
    }
  });
});

Deno.test("planConfigAdoption: verifyTierCopies adopts a tier copy the commit log never held", async () => {
  await withTempDir(async (repoDir) => {
    const configBase = join(repoDir, ".swamp", "config");
    const text = `id: ${ID_1}\nname: w1\n`;
    await writeFile(join(repoDir, "workflows", "workflow-w1.yaml"), text);
    await writeFile(join(configBase, "workflows", "workflow-w1.yaml"), text);
    const trusted = await planConfigAdoption({
      repoDir,
      configBase,
      partitionHasCommits: () => Promise.resolve(false),
    });
    assertEquals(trusted.adoptions, []);
    const verified = await planConfigAdoption({
      repoDir,
      configBase,
      partitionHasCommits: () => Promise.resolve(false),
      verifyTierCopies: true,
    });
    assertEquals(verified.adoptions.map((a) => a.name), ["w1"]);
  });
});

Deno.test("planConfigAdoption: the repo's lockfile is adopted with its pulled extensions while the commit log has none", async () => {
  await withTempDir(async (repoDir) => {
    const configBase = join(repoDir, ".swamp", "config");
    const lockfileSource = join(
      repoDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );
    await writeFile(lockfileSource, "{}\n");
    await writeFile(
      join(repoDir, ".swamp", "pulled-extensions", "@t", "x", "manifest.yaml"),
      'name: "@t/x"\n',
    );
    const plan = await planConfigAdoption({
      repoDir,
      configBase,
      partitionHasCommits: () => Promise.resolve(false),
      lockfileSource,
    });
    assertPathEquals(
      plan.lockfile!.targetPath,
      join(configBase, "upstream_extensions.json"),
    );
    assertPathEquals(
      plan.lockfile!.pulledExtensions!.target,
      join(repoDir, ".swamp", "config", "pulled-extensions"),
    );
    const committed = await planConfigAdoption({
      repoDir,
      configBase,
      partitionHasCommits: (partition) =>
        Promise.resolve(
          partition.toString() === "config--lockfile--upstream_extensions",
        ),
      lockfileSource,
    });
    assertEquals(committed.lockfile, undefined);
  });
});
