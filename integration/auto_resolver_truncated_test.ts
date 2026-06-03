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
import { ensureDir, walk } from "@std/fs";
import { join, relative } from "@std/path";
import {
  createAutoResolveInstallerAdapter,
  createAutoResolveOutputAdapter,
} from "../src/cli/auto_resolver_adapters.ts";
import { ExtensionAutoResolver } from "../src/domain/extensions/extension_auto_resolver.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";

// Regression guard for swamp-club issue 133: when a pulled extension's
// on-disk tree is present but incomplete (one or more lockfile-declared
// files are missing), auto-resolve must emit the new
// `alreadyInstalledTruncated` event naming the missing files — NOT the
// misleading "Unknown <kind> type" fallback the old code produced, and
// NOT a silent reinstall. The fix is read-only: the pulled tree on disk
// must be byte-identical before and after the resolve attempt.
//
// This is a collaborator-style integration test: it wires the real
// adapter into the real domain service against a hand-written scratch
// repo, rather than shelling through the CLI. The end-to-end CLI path
// is covered by the CLI UAT suite; here we exercise the full domain →
// port → adapter → filesystem path with a hermetic fixture so there is
// no registry dependency.

const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/usr/bin/false"),
};

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for await (const entry of walk(root, { includeDirs: false })) {
    const bytes = await Deno.readFile(entry.path);
    // A zero-mutation assertion needs byte-level equality. Base64 is
    // stable for Map<string, string> comparison via assertEquals and
    // doesn't require extra deps like @std/encoding/hex.
    snapshot.set(
      relative(root, entry.path),
      btoa(String.fromCharCode(...bytes)),
    );
  }
  return snapshot;
}

Deno.test("integration: auto-resolver surfaces truncated error and leaves the tree untouched", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_issue_133_" });
  try {
    const extensionName = "@test/truncated";
    const extRoot = join(
      tmpDir,
      ".swamp",
      "pulled-extensions",
      extensionName,
    );
    await ensureDir(join(extRoot, "models"));

    // Two declared files. One survives; one is deleted below to produce
    // the truncated state. The lockfile lists both, so the inspection
    // sees "one missing" and returns { state: "truncated", missing: [..]}.
    const keptRel = join(
      ".swamp/pulled-extensions",
      extensionName,
      "manifest.yaml",
    );
    const goneRel = join(
      ".swamp/pulled-extensions",
      extensionName,
      "models",
      "deleted.ts",
    );
    const keptPath = join(tmpDir, keptRel);
    const gonePath = join(tmpDir, goneRel);

    await Deno.writeTextFile(
      keptPath,
      "manifestVersion: 1\nname: '@test/truncated'\nversion: 2026.01.01.1\n",
    );
    await Deno.writeTextFile(gonePath, "// will be deleted\n");

    const lockfilePath = join(
      tmpDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );
    await ensureDir(join(tmpDir, "extensions", "models"));
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify(
        {
          [extensionName]: {
            version: "2026.01.01.1",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [keptRel, goneRel],
          },
        },
        null,
        2,
      ),
    );

    // Produce the truncation: remove one of the declared files. The
    // directory stays — this is the exact state the issue describes.
    await Deno.remove(gonePath);

    // Snapshot the pulled tree so we can assert zero-mutation after the
    // resolve attempt. The fix is read-only; a regression that
    // reintroduced filesystem mutation (e.g. auto-repair) would show up
    // as a snapshot diff.
    const before = await snapshotTree(extRoot);

    // Capture json output so we can assert the new `truncated` event
    // fires with the expected shape.
    const emitted: string[] = [];
    const originalLog = console.log;
    console.log = (line: unknown) => {
      if (typeof line === "string") emitted.push(line);
    };

    const adapter = createAutoResolveInstallerAdapter({
      getExtension: (name: string) =>
        name === extensionName
          ? Promise.resolve({
            name,
            description: "Truncated fixture",
            latestVersion: "2026.01.01.1",
          })
          : Promise.resolve(null),
      downloadArchive: () =>
        Promise.reject(
          new Error(
            "REGRESSION: install was attempted on a truncated extension",
          ),
        ),
      getChecksum: () => Promise.resolve(null),
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    let result: boolean;
    try {
      const output = createAutoResolveOutputAdapter("json");
      const resolver = new ExtensionAutoResolver({
        allowedCollectives: ["test"],
        extensionLookup: {
          getExtension: (name: string) =>
            name === extensionName
              ? Promise.resolve({
                name,
                description: "Truncated fixture",
                latestVersion: "2026.01.01.1",
              })
              : Promise.resolve(null),
          searchExtensions: () => Promise.resolve({ extensions: [] }),
        },
        extensionInstaller: adapter,
        output,
      });

      result = await resolver.resolve(`${extensionName}/some-type`);
    } finally {
      console.log = originalLog;
    }

    // Resolve reports failure — the type couldn't be registered.
    assertEquals(result, false);

    // JSON event for the truncated state fires, names the extension and
    // path, and includes the missing file. Shape must stay compatible
    // with scripting consumers that key off `reason: "truncated"`.
    //
    // Asserting on a parsed object (not a substring of the raw line)
    // means path values flow through host-native separators without
    // tripping the test on backslash-encoded JSON literals on Windows.
    const truncatedEvent = emitted
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.reason === "truncated");
    if (!truncatedEvent) {
      throw new Error(
        `expected a truncated auto_resolve event, got: ${emitted.join("\n")}`,
      );
    }
    assertEquals(truncatedEvent.event, "auto_resolve");
    assertEquals(truncatedEvent.status, "failed");
    assertEquals(truncatedEvent.extension, extensionName);
    // `missing` carries paths; normalize separators on both sides so
    // the assertion is host-agnostic.
    const normalizedMissing = (truncatedEvent.missing as string[]).map((p) =>
      p.replaceAll("\\", "/")
    );
    assertEquals(normalizedMissing, [goneRel.replaceAll("\\", "/")]);

    // The pulled tree on disk must be byte-identical to before — no
    // auto-repair, no overwrite, no side effects.
    const after = await snapshotTree(extRoot);
    assertEquals(after, before);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
