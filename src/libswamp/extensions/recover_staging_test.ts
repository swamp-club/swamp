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
import { assertStringIncludes } from "@std/assert/string-includes";
import { join } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import { ExtensionInstallTransaction } from "../../infrastructure/persistence/extension_install_transaction.ts";
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

Deno.test("assertNoBlockingJournal: names the live root and the dir to delete", () => {
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
    join(".swamp", "pulled-extensions", "@acme", "thing"),
  );
  assertStringIncludes(
    error.message,
    `delete ${join(".swamp", "pulled-extensions", ".swamp-staging", "id")}`,
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
