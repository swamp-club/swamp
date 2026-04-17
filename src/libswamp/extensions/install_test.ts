// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { ensureDir } from "@std/fs";
import { extensionInstall, type ExtensionInstallEvent } from "./install.ts";
import { createLibSwampContext } from "../context.ts";

async function collectEvents(
  gen: AsyncIterable<ExtensionInstallEvent>,
): Promise<ExtensionInstallEvent[]> {
  const events: ExtensionInstallEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

Deno.test("extensionInstall: empty lockfile yields all up to date", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    // Write empty lockfile
    await Deno.writeTextFile(lockfilePath, "{}");

    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: () => {
          throw new Error("should not be called");
        },
      }),
    );

    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.installed, 0);
      assertEquals(completed.data.upToDate, 0);
      assertEquals(completed.data.failed, 0);
      assertEquals(completed.data.entries, []);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extensionInstall: skips extensions with all files present", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    // Create the files on disk
    const pulledDir = join(tmpDir, ".swamp", "pulled-extensions", "models");
    await ensureDir(pulledDir);
    await Deno.writeTextFile(join(pulledDir, "test.ts"), "// test");

    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@test/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/models/test.ts"],
        },
      }),
    );

    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: () => {
          throw new Error("should not be called for up-to-date");
        },
      }),
    );

    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.upToDate, 1);
      assertEquals(completed.data.installed, 0);
      assertEquals(completed.data.entries[0].status, "up_to_date");
      assertEquals(completed.data.entries[0].name, "@test/ext");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extensionInstall: detects missing files and calls install", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@test/missing": {
          version: "2.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/models/missing.ts"],
        },
      }),
    );

    let installCalled = false;
    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: (_name, _version) => {
          installCalled = true;
          // Return a minimal context that won't actually pull
          // (installExtension will fail, which we catch)
          return {
            getExtension: () => Promise.resolve(null),
            downloadArchive: () => Promise.reject(new Error("test stub")),
            getChecksum: () => Promise.resolve(null),
            lockfilePath,
            skillsDir: join(tmpDir, ".swamp/pulled-extensions/skills"),
            repoDir: tmpDir,
            force: true,
            alreadyPulled: new Set<string>(),
            depth: 0,
          };
        },
      }),
    );

    assertEquals(installCalled, true);

    // Should have an "installing" event
    const installing = events.find((e) => e.kind === "installing");
    assertEquals(installing?.kind, "installing");
    if (installing?.kind === "installing") {
      assertEquals(installing.name, "@test/missing");
      assertEquals(installing.version, "2.0.0");
    }

    // Install will fail since our stub rejects — that's fine, we're testing detection
    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.failed, 1);
      assertEquals(completed.data.entries[0].status, "failed");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extensionInstall: missing lockfile yields empty result", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "nonexistent.json");

    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: () => {
          throw new Error("should not be called");
        },
      }),
    );

    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.entries.length, 0);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extensionInstall: lockfile-anchored checksum mismatch fails with drift message", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    // Seed a lockfile pointing at files that don't exist on disk (so
    // hasAnyMissingFiles triggers the install path) with a stored
    // checksum that will not match the "fresh download" bytes.
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@fake/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          // SHA-256 this value will never match our stub's bytes.
          checksum: "0".repeat(64),
          files: [".swamp/pulled-extensions/@fake/ext/models/missing.ts"],
        },
      }),
    );

    // Stub downloadArchive returns bytes that — when SHA-256'd — won't
    // match the stored checksum. installExtension must throw BEFORE
    // attempting tar extraction, so the nonsense bytes never matter.
    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: () => ({
          getExtension: () =>
            Promise.resolve({
              name: "@fake/ext",
              description: "test",
              latestVersion: "1.0.0",
            }),
          downloadArchive: () =>
            Promise.resolve(new TextEncoder().encode("drifted content")),
          getChecksum: () => Promise.resolve(null),
          lockfilePath,
          skillsDir: "unused",
          repoDir: tmpDir,
          force: true,
          alreadyPulled: new Set<string>(),
          depth: 0,
        }),
      }),
    );

    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.failed, 1);
      assertEquals(completed.data.entries[0].status, "failed");
      // Error should name checksum, stored, fetched, and offer the
      // user-recovery hint (pull to accept).
      const err = completed.data.entries[0].error ?? "";
      if (!err.includes("Checksum mismatch")) {
        throw new Error(`expected drift message, got: ${err}`);
      }
      if (!err.includes("'swamp extension pull @fake/ext'")) {
        throw new Error(`expected recovery hint, got: ${err}`);
      }
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
