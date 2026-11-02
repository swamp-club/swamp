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

// a truncated pulled tree emits alreadyInstalledTruncated naming the missing
// files, with no silent reinstall; the tree on disk must stay byte-identical

const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/usr/bin/false"),
  getDenoEnv: () => Deno.env.toObject(),
};

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for await (const entry of walk(root, { includeDirs: false })) {
    const bytes = await Deno.readFile(entry.path);
    // base64 gives byte-level equality that assertEquals can compare in a Map
    // without extra deps
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

    await Deno.remove(gonePath);

    const before = await snapshotTree(extRoot);

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

    assertEquals(result, false);

    // the event shape must stay compatible with scripting consumers keying off
    // reason: truncated; a parsed object avoids Windows backslash-encoded JSON
    // in substring checks
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

    const after = await snapshotTree(extRoot);
    assertEquals(after, before);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
