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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  createAutoResolveInstallerAdapter,
  createAutoResolveOutputAdapter,
} from "../src/cli/auto_resolver_adapters.ts";
import { ExtensionAutoResolver } from "../src/domain/extensions/extension_auto_resolver.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";

// Regression guard for swamp-club issue 121: an auto-resolver attempt on
// a type whose extension is already installed on disk must NEVER overwrite
// the local copy. Pre-fix, the adapter passed force:true to installExtension
// and silently clobbered user edits. This test assembles the real adapter
// and real domain service and confirms the file-survival invariant: the
// on-disk file's mtime and contents are unchanged after a failed
// auto-resolution.

const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/usr/bin/false"),
  getDenoEnv: () => Deno.env.toObject(),
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
          adapter.inspectInstallation(name).then((inspection) =>
            inspection.state !== "missing"
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

Deno.test("integration: auto-resolver preserves legacy source files", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_issue_2183_" });
  try {
    const extensionName = "@test/legacy";
    const legacyDir = join(tmpDir, "extensions", "models");
    const legacyFile = join(legacyDir, "legacy.ts");
    const legacyContents = "// Legacy source\n";
    await ensureDir(legacyDir);
    await Deno.writeTextFile(legacyFile, legacyContents);

    const lockfilePath = join(
      tmpDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );
    await ensureDir(join(tmpDir, "extensions", "models"));
    const originalLockfile = JSON.stringify(
      {
        [extensionName]: {
          version: "2026.01.01.1",
          pulledAt: "2026-01-01T00:00:00Z",
          files: ["extensions/models/legacy.ts", ".claude/skills/legacy"],
        },
      },
      null,
      2,
    );
    await Deno.writeTextFile(lockfilePath, originalLockfile);

    let downloadArchiveCalled = false;
    const adapter = createAutoResolveInstallerAdapter({
      getExtension: (name: string) =>
        name === extensionName
          ? Promise.resolve({
            name,
            description: "Legacy fixture",
            latestVersion: "2026.01.01.1",
          })
          : Promise.resolve(null),
      downloadArchive: () => {
        downloadArchiveCalled = true;
        return Promise.reject(
          new Error("REGRESSION: install was attempted on legacy files"),
        );
      },
      getChecksum: () => Promise.resolve(null),
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });
    const resolver = new ExtensionAutoResolver({
      allowedCollectives: ["test"],
      extensionLookup: {
        getExtension: (name: string) =>
          name === extensionName
            ? Promise.resolve({
              name,
              description: "Legacy fixture",
              latestVersion: "2026.01.01.1",
            })
            : Promise.resolve(null),
        searchExtensions: () => Promise.resolve({ extensions: [] }),
      },
      extensionInstaller: adapter,
      output: createAutoResolveOutputAdapter("json"),
    });

    const result = await resolver.resolve(`${extensionName}/some-type`);

    assertEquals(result, false);
    assertEquals(downloadArchiveCalled, false);
    assertEquals(await Deno.readTextFile(legacyFile), legacyContents);
    assertEquals(await Deno.readTextFile(lockfilePath), originalLockfile);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// swamp-club#3727: a pinned extension whose recorded skill dir survives
// an empty pulled cache is reinstalled, not refused as legacy. The skill
// goes back where the lockfile records it, so the entry keeps its skill
// path and the dir is not pruned.
Deno.test("integration: auto-resolver reinstalls a pinned extension over its surviving skill dir", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_issue_3727_" });
  try {
    const extensionName = "@test/skilled";
    const version = "2026.01.01.1";
    const skillDir = join(tmpDir, ".claude", "skills", "skilled");
    await ensureDir(skillDir);
    await Deno.writeTextFile(join(skillDir, "SKILL.md"), "# old\n");

    const lockfilePath = join(
      tmpDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );
    await ensureDir(join(tmpDir, "extensions", "models"));
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        [extensionName]: {
          version,
          pulledAt: "2026-01-01T00:00:00Z",
          files: [
            `.swamp/pulled-extensions/${extensionName}/manifest.yaml`,
            ".claude/skills/skilled",
          ],
        },
      }),
    );

    const archiveDir = await Deno.makeTempDir({ prefix: "swamp_arc_" });
    let archive: Uint8Array;
    try {
      const extDir = join(archiveDir, "extension");
      await ensureDir(join(extDir, "skills", "skilled"));
      await Deno.writeTextFile(
        join(extDir, "manifest.yaml"),
        `manifestVersion: 1\nname: "${extensionName}"\nversion: "${version}"\nskills:\n  - skilled\n`,
      );
      await Deno.writeTextFile(
        join(extDir, "skills", "skilled", "SKILL.md"),
        "# new\n",
      );
      await createTarGz(extDir, join(archiveDir, "a.tar.gz"));
      archive = await Deno.readFile(join(archiveDir, "a.tar.gz"));
    } finally {
      await Deno.remove(archiveDir, { recursive: true });
    }

    const lookup = (name: string) =>
      name === extensionName
        ? Promise.resolve({
          name,
          description: "Skilled fixture",
          latestVersion: version,
        })
        : Promise.resolve(null);
    let downloads = 0;
    const adapter = createAutoResolveInstallerAdapter({
      getExtension: lookup,
      downloadArchive: () => {
        downloads++;
        return Promise.resolve(archive);
      },
      getChecksum: () => Promise.resolve(null),
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });
    const resolver = new ExtensionAutoResolver({
      allowedCollectives: ["test"],
      extensionLookup: {
        getExtension: lookup,
        searchExtensions: () => Promise.resolve({ extensions: [] }),
      },
      extensionInstaller: adapter,
      output: createAutoResolveOutputAdapter("json"),
    });

    // The fixture ships no type, so resolve reports false after the
    // install; what matters is that the install ran.
    await resolver.resolve(`${extensionName}/some-type`);

    assertEquals(downloads, 1);
    assertEquals(
      await Deno.readTextFile(join(skillDir, "SKILL.md")),
      "# new\n",
    );
    const lockfile = JSON.parse(await Deno.readTextFile(lockfilePath));
    assertEquals(
      lockfile[extensionName].files.includes(".claude/skills/skilled"),
      true,
    );
    assertEquals(
      lockfile[extensionName].files.some((f: string) =>
        f.startsWith(".swamp/pulled-extensions/skills/")
      ),
      false,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
