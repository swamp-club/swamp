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
 * runs the verifier conformance suite for both healthy and unhealthy paths,
 * since the suite validates only the result shape; the healthy flag is asserted
 * alongside
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { assertVerifierConformance } from "@swamp-club/swamp-testing";
import { FilesystemDatastoreVerifier } from "./filesystem_datastore_verifier.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-verifier-conformance-",
  });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("FilesystemDatastoreVerifier: healthy directory satisfies verifier conformance contract", async () => {
  await withTempDir(async (dir) => {
    const verifier = new FilesystemDatastoreVerifier(dir);
    await assertVerifierConformance(verifier);
    const result = await verifier.verify();
    assertEquals(result.healthy, true);
  });
});

Deno.test("FilesystemDatastoreVerifier: missing directory still returns conformant result", async () => {
  await withTempDir(async (dir) => {
    const verifier = new FilesystemDatastoreVerifier(
      join(dir, "does-not-exist"),
    );
    await assertVerifierConformance(verifier);
    const result = await verifier.verify();
    assertEquals(result.healthy, false);
  });
});

Deno.test("FilesystemDatastoreVerifier: file path (not a directory) still returns conformant result", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "a-file");
    await Deno.writeTextFile(filePath, "not a directory");
    const verifier = new FilesystemDatastoreVerifier(filePath);
    await assertVerifierConformance(verifier);
    const result = await verifier.verify();
    assertEquals(result.healthy, false);
  });
});
