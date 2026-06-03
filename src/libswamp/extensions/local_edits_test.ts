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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  detectLocalEditsForExtension,
  LocalEditsError,
} from "./local_edits.ts";
import { readInstalledExtensionDigest } from "../../infrastructure/persistence/installed_extension_digest_reader.ts";
import { UserError } from "../../domain/errors.ts";

const EXT_NAME = "@test/ext";

async function withRepo(
  fn: (repoDir: string, lockfilePath: string, extRoot: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_local_edits_" });
  try {
    const modelsDir = join(repoDir, "extensions", "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const lockfilePath = join(modelsDir, "upstream_extensions.json");
    const extRoot = join(repoDir, ".swamp", "pulled-extensions", EXT_NAME);
    await Deno.mkdir(extRoot, { recursive: true });
    await fn(repoDir, lockfilePath, extRoot);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
}

async function writeLockfile(
  lockfilePath: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await Deno.writeTextFile(
    lockfilePath,
    JSON.stringify({ [EXT_NAME]: entry }, null, 2) + "\n",
  );
}

Deno.test("detectLocalEditsForExtension: match when on-disk digest equals anchor", async () => {
  await withRepo(async (repoDir, lockfilePath, extRoot) => {
    await Deno.mkdir(join(extRoot, "models"), { recursive: true });
    await Deno.writeTextFile(join(extRoot, "models", "foo.ts"), "content");
    const anchor = await readInstalledExtensionDigest(extRoot);
    assert(anchor !== null);
    await writeLockfile(lockfilePath, {
      version: "1.0.0",
      pulledAt: new Date().toISOString(),
      filesChecksum: anchor,
    });

    const result = await detectLocalEditsForExtension(
      repoDir,
      EXT_NAME,
      lockfilePath,
    );
    assertEquals(result, "match");
  });
});

Deno.test("detectLocalEditsForExtension: mismatch when a file is edited after install", async () => {
  await withRepo(async (repoDir, lockfilePath, extRoot) => {
    await Deno.mkdir(join(extRoot, "models"), { recursive: true });
    await Deno.writeTextFile(join(extRoot, "models", "foo.ts"), "original");
    const anchor = await readInstalledExtensionDigest(extRoot);
    assert(anchor !== null);
    await writeLockfile(lockfilePath, {
      version: "1.0.0",
      pulledAt: new Date().toISOString(),
      filesChecksum: anchor,
    });

    await Deno.writeTextFile(join(extRoot, "models", "foo.ts"), "edited");

    const result = await detectLocalEditsForExtension(
      repoDir,
      EXT_NAME,
      lockfilePath,
    );
    assertEquals(result, "mismatch");
  });
});

Deno.test("detectLocalEditsForExtension: no-anchor when lockfile entry lacks filesChecksum", async () => {
  await withRepo(async (repoDir, lockfilePath, extRoot) => {
    await Deno.mkdir(join(extRoot, "models"), { recursive: true });
    await Deno.writeTextFile(join(extRoot, "models", "foo.ts"), "content");
    await writeLockfile(lockfilePath, {
      version: "1.0.0",
      pulledAt: new Date().toISOString(),
      // Pre-anchor lockfile entry: no filesChecksum field.
    });

    const result = await detectLocalEditsForExtension(
      repoDir,
      EXT_NAME,
      lockfilePath,
    );
    assertEquals(result, "no-anchor");
  });
});

Deno.test("detectLocalEditsForExtension: no-anchor when lockfile does not exist", async () => {
  await withRepo(async (repoDir, _lockfilePath, _extRoot) => {
    const missingLockfile = join(repoDir, "missing-lockfile.json");
    const result = await detectLocalEditsForExtension(
      repoDir,
      EXT_NAME,
      missingLockfile,
    );
    assertEquals(result, "no-anchor");
  });
});

Deno.test("detectLocalEditsForExtension: no-anchor when per-extension dir is missing", async () => {
  await withRepo(async (repoDir, lockfilePath, extRoot) => {
    await writeLockfile(lockfilePath, {
      version: "1.0.0",
      pulledAt: new Date().toISOString(),
      filesChecksum: "deadbeef".repeat(8),
    });
    await Deno.remove(extRoot, { recursive: true });

    const result = await detectLocalEditsForExtension(
      repoDir,
      EXT_NAME,
      lockfilePath,
    );
    assertEquals(result, "no-anchor");
  });
});

Deno.test("LocalEditsError: message names the extension and the remediation", () => {
  const err = new LocalEditsError("@swamp/aws-ec2");
  assertStringIncludes(err.message, "@swamp/aws-ec2");
  assertStringIncludes(
    err.message,
    "swamp extension pull @swamp/aws-ec2 --force",
  );
  assertEquals(err.extensionName, "@swamp/aws-ec2");
  assertEquals(err.name, "LocalEditsError");
  assert(err instanceof UserError);
});
