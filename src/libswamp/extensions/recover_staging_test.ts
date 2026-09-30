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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { assertStringIncludes } from "@std/assert/string-includes";
import { join, relative } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import {
  defaultInstallFsOps,
  ExtensionInstallTransaction,
  type ExtensionRootCopies,
} from "../../infrastructure/persistence/extension_install_transaction.ts";
import type { ObservedPath } from "../../domain/extensions/install_journal.ts";
import {
  extensionInstallRoots,
  registerManagedConfig,
  resolvePulledExtensionsRoot,
} from "../../infrastructure/persistence/paths.ts";
import {
  crashAware,
  SimulatedInstallCrash,
} from "../../infrastructure/persistence/test_helpers/install_crash.ts";
import {
  assertNoBlockingJournal,
  recoverPulledExtensionStaging,
  type StagingRecoveryReport,
} from "./recover_staging.ts";

async function withRepo(fn: (repoDir: string) => Promise<void>) {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_recover_" });
  try {
    await fn(repoDir);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

/** Starts an install of `name` and kills it before any rename. */
async function crashedInstall(
  repoDir: string,
  name: string,
  lockfilePath: string,
): Promise<string> {
  const roots = extensionInstallRoots(repoDir, name);
  const tx = await ExtensionInstallTransaction.begin({
    repoDir,
    pulledRoot: resolvePulledExtensionsRoot(repoDir),
    extensionName: name,
    lockfilePath,
    newChecksum: "sum",
    newManifestDigest: "digest",
    roots: [{ role: "extension", live: roots.extensionRoot, hasNew: true }],
    nestedRoots: [],
    ops: crashAware(),
  });
  await tx.settle(
    new SimulatedInstallCrash("died"),
    () => Promise.resolve(null),
  );
  return tx.journal.stagingId;
}

function report(left: StagingRecoveryReport["left"]): StagingRecoveryReport {
  return { rolledForward: [], rolledBack: [], left, swept: [] };
}

Deno.test("recoverPulledExtensionStaging: accepts the default lockfile without being told", async () => {
  await withRepo(async (repoDir) => {
    const lockfile = join(
      repoDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );
    await crashedInstall(repoDir, "@acme/thing", lockfile);
    const result = await recoverPulledExtensionStaging(repoDir);
    assertEquals(result.rolledBack, ["@acme/thing"]);
    assertEquals(result.left, []);
  });
});

Deno.test("recoverPulledExtensionStaging: accepts a caller's lockfile on top of the derived ones", async () => {
  await withRepo(async (repoDir) => {
    const lockfile = join(repoDir, "custom", "upstream_extensions.json");
    await crashedInstall(repoDir, "@acme/thing", lockfile);

    const refused = await recoverPulledExtensionStaging(repoDir);
    assertEquals(refused.rolledBack, []);
    assertEquals(refused.left.map((l) => l.extensionName), ["@acme/thing"]);

    const accepted = await recoverPulledExtensionStaging(repoDir, {
      lockfilePaths: [lockfile],
    });
    assertEquals(accepted.rolledBack, ["@acme/thing"]);
  });
});

Deno.test("recoverPulledExtensionStaging: rolls back an install interrupted before the repo moved", async () => {
  await withRepo(async (parent) => {
    const repoDir = join(parent, "repo");
    const name = "@acme/thing";
    const lockfile = join(
      repoDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );
    const roots = extensionInstallRoots(repoDir, name);
    const v1 = join(roots.extensionRoot, "manifest.yaml");
    await Deno.mkdir(roots.extensionRoot, { recursive: true });
    await Deno.writeTextFile(v1, "version: 1\n");

    // The upgrade dies once phase 1 has moved the live root aside.
    let renames = 0;
    const tx = await ExtensionInstallTransaction.begin({
      repoDir,
      pulledRoot: resolvePulledExtensionsRoot(repoDir),
      extensionName: name,
      lockfilePath: lockfile,
      newChecksum: "sum",
      newManifestDigest: "digest",
      roots: [{ role: "extension", live: roots.extensionRoot, hasNew: true }],
      nestedRoots: [],
      ops: crashAware({
        rename: async (from, to) => {
          if (++renames === 2) throw new SimulatedInstallCrash("died");
          await defaultInstallFsOps.rename(from, to);
        },
      }),
    });
    await assertRejects(() => tx.swap(), SimulatedInstallCrash);
    await tx.settle(
      new SimulatedInstallCrash("died"),
      () => Promise.resolve(null),
    );

    const moved = join(parent, "moved");
    await Deno.rename(repoDir, moved);
    const result = await recoverPulledExtensionStaging(moved);
    assertEquals(result.left, []);
    assertEquals(result.rolledBack, [name]);
    assertEquals(
      await Deno.readTextFile(join(moved, relative(repoDir, v1))),
      "version: 1\n",
    );
  });
});

const STAGING = join(".swamp", "pulled-extensions", ".swamp-staging", "id");
const LIVE = join(".swamp", "pulled-extensions", "@acme", "thing");
const OLD = join(STAGING, "old", "0");

/** The refusal for a left journal of `@acme/thing` with these copies. */
function refusal(liveState: ObservedPath, oldState: ObservedPath): string {
  const repoDir = `/tmp/swamp-recover-${crypto.randomUUID()}`;
  const extensionRoot: ExtensionRootCopies = {
    live: join(repoDir, LIVE),
    liveState,
    old: join(repoDir, OLD),
    oldState,
  };
  return assertThrows(
    () =>
      assertNoBlockingJournal(
        report([{
          journalPath: join(repoDir, STAGING, "journal.json"),
          extensionName: "@acme/thing",
          reason: "invalid journal: root index 3 repeats",
          extensionRoot,
        }]),
        repoDir,
        "@acme/thing",
        "install",
      ),
    UserError,
  ).message;
}

Deno.test("assertNoBlockingJournal: says to move the previous version back when only it is left", () => {
  const message = refusal("absent", "dir");
  assertStringIncludes(
    message,
    `the previous version of @acme/thing is in ${OLD} and ${LIVE} is missing: ` +
      `move ${OLD} to ${LIVE}, then delete ${STAGING} and retry.`,
  );
});

Deno.test("assertNoBlockingJournal: names both copies when the previous version and a live root exist", () => {
  const message = refusal("dir", "symlink");
  assertStringIncludes(
    message,
    `the previous version of @acme/thing is in ${OLD}, and ${LIVE} may hold`,
  );
  assertStringIncludes(message, `then delete ${STAGING} and retry.`);
});

Deno.test("assertNoBlockingJournal: asks to check the live root when no previous version is staged", () => {
  const message = refusal("dir", "absent");
  assertStringIncludes(
    message,
    `once you have checked that ${LIVE} holds the version you want, ` +
      `delete ${STAGING} and retry.`,
  );
});

Deno.test("assertNoBlockingJournal: says to pull again when no copy is left", () => {
  const message = refusal("absent", "absent");
  assertStringIncludes(
    message,
    `no copy of @acme/thing is left at ${LIVE} or in ${OLD}: ` +
      `delete ${STAGING}, then pull @acme/thing again.`,
  );
});

Deno.test("assertNoBlockingJournal: warns the staging may hold the only copy when the copies are unknown", () => {
  const repoDir = `/tmp/swamp-recover-${crypto.randomUUID()}`;
  const journalDir = join(
    repoDir,
    ".swamp",
    "pulled-extensions",
    ".swamp-staging",
    "id",
  );
  const error = assertThrows(
    () =>
      assertNoBlockingJournal(
        report([{
          journalPath: join(journalDir, "journal.json"),
          extensionName: "@acme/thing",
          reason: "invalid journal: root index 3 repeats",
        }]),
        repoDir,
        "@acme/thing/child",
        "install",
      ),
    UserError,
  );
  assertStringIncludes(error.message, "Cannot install @acme/thing/child");
  assertStringIncludes(
    error.message,
    `check ${join(STAGING, "old")} before deleting ${STAGING}: it may hold ` +
      `the only copy of @acme/thing's previous version, which belongs at ` +
      `${LIVE}.`,
  );
});

Deno.test("assertNoBlockingJournal: points at the managed-config pulled root", () => {
  const repoDir = `/tmp/swamp-recover-${crypto.randomUUID()}`;
  registerManagedConfig(repoDir, true, join(repoDir, ".swamp", "config"));
  const error = assertThrows(
    () =>
      assertNoBlockingJournal(
        report([{
          journalPath: "/x/journal.json",
          extensionName: "@acme/thing",
          reason: "recovery failed",
        }]),
        repoDir,
        "@acme/thing",
        "remove",
      ),
    UserError,
  );
  assertStringIncludes(
    error.message,
    join(".swamp", "config", "pulled-extensions", "@acme", "thing"),
  );
});

Deno.test("assertNoBlockingJournal: ignores journals of unrelated extensions", () => {
  assertNoBlockingJournal(
    report([{
      journalPath: "/x/journal.json",
      extensionName: "@acme/other",
      reason: "recovery failed",
    }, {
      journalPath: "/y/journal.json",
      extensionName: null,
      reason: "the journal cannot be read",
    }]),
    "/tmp/repo",
    "@acme/thing",
    "install",
  );
});
