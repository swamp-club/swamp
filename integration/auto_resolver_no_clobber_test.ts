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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  createAutoResolveInstallerAdapter,
  createAutoResolveOutputAdapter,
} from "../src/cli/auto_resolver_adapters.ts";
import { ExtensionAutoResolver } from "../src/domain/extensions/extension_auto_resolver.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";

// Regression guard for swamp-club issue 121: an auto-resolver attempt on
// a type whose extension is already installed on disk must NEVER overwrite
// the local copy. Pre-fix, the adapter passed force:true to installExtension
// and silently clobbered user edits. This test assembles the real adapter
// and real domain service and confirms the file-survival invariant: the
// on-disk file's mtime and contents are unchanged after a failed
// auto-resolution.

const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/usr/bin/false"),
};

Deno.test("integration: auto-resolver refuses to overwrite an existing pulled extension", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_issue_121_" });
  try {
    const extensionName = "@test/fixture";
    const extRoot = join(
      tmpDir,
      ".swamp",
      "pulled-extensions",
      extensionName,
    );
    const modelsDir = join(extRoot, "models");
    await ensureDir(modelsDir);

    // "User's local edits" — a marker comment that must survive the
    // failed auto-resolve attempt.
    const localFile = join(modelsDir, "local_wip.ts");
    const localContents = [
      "// MY LOCAL WIP — do not lose this",
      "export const model = { broken: true };",
    ].join("\n");
    await Deno.writeTextFile(localFile, localContents);
    const originalMtime = (await Deno.stat(localFile)).mtime?.getTime();

    // Lockfile records the fixture extension — isInstalled must return
    // true on this combination (lockfile entry AND dir present).
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
            files: [join(".swamp/pulled-extensions", extensionName, "models")],
          },
        },
        null,
        2,
      ),
    );

    // The getExtension callback advertises the fixture — but install()
    // must never be called, because isInstalled will short-circuit it.
    // downloadArchive throws if reached; that's the regression signal.
    let downloadArchiveCalled = false;
    const adapter = createAutoResolveInstallerAdapter({
      getExtension: (name: string) =>
        name === extensionName
          ? Promise.resolve({
            name,
            description: "Test fixture",
            latestVersion: "2026.01.01.1",
          })
          : Promise.resolve(null),
      downloadArchive: () => {
        downloadArchiveCalled = true;
        return Promise.reject(
          new Error(
            "REGRESSION: install was attempted on an on-disk extension",
          ),
        );
      },
      getChecksum: () => Promise.resolve(null),
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    // Assemble the real service with a silent output adapter so the
    // test stays quiet. We check behavior via adapter calls and file
    // state, not via log lines.
    const output = createAutoResolveOutputAdapter("json");
    const resolver = new ExtensionAutoResolver({
      allowedCollectives: ["test"],
      extensionLookup: {
        getExtension: (name: string) =>
          adapter.isInstalled(name).then((installed) =>
            installed
              ? Promise.resolve({
                name,
                description: "Test fixture",
                latestVersion: "2026.01.01.1",
              })
              : Promise.resolve(null)
          ),
        searchExtensions: () => Promise.resolve({ extensions: [] }),
      },
      extensionInstaller: adapter,
      output,
    });

    const result = await resolver.resolve(`${extensionName}/some-type`);

    // The resolver must report failure — the type couldn't be
    // registered and we refused to install.
    assertEquals(result, false);
    // install() must not have reached the downloadArchive callback.
    assertEquals(downloadArchiveCalled, false);
    // The local file must still exist with the original contents and
    // mtime. These two assertions are the core user-visible invariant.
    const currentContents = await Deno.readTextFile(localFile);
    assertEquals(currentContents, localContents);
    const currentMtime = (await Deno.stat(localFile)).mtime?.getTime();
    assertEquals(currentMtime, originalMtime);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
