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
import {
  isAbsentFromDisk,
  pathsToRemoveForReinstall,
  readInstalledEntries,
  transitionalInstalledNames,
  transitionalLocalLockfilePath,
} from "./installed_entries.ts";
import type { RepoMarkerData } from "./repo_marker_repository.ts";
import { assertPathEquals } from "./path_test_helpers.ts";
import { resolvePulledExtensionsRoot } from "./paths.ts";

const unset = () => undefined;

function marker(type: string, managedConfig = true): RepoMarkerData {
  return {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    datastore: { type, managedConfig },
  };
}

function entry(version: string) {
  return { version, pulledAt: "2026-01-01T00:00:00Z" };
}

Deno.test("transitionalLocalLockfilePath: returns the in-repo lockfile for an extension datastore", () => {
  assertPathEquals(
    transitionalLocalLockfilePath(
      "/repo",
      marker("@swamp/s3-datastore"),
      "/cache/ns/config/upstream_extensions.json",
      unset,
    ) ?? "",
    "/repo/.swamp/config/upstream_extensions.json",
  );
});

Deno.test("transitionalLocalLockfilePath: undefined for filesystem and unmanaged repos", () => {
  assertEquals(
    transitionalLocalLockfilePath(
      "/repo",
      marker("filesystem"),
      "/tmp/ds/config/upstream_extensions.json",
      unset,
    ),
    undefined,
  );
  assertEquals(
    transitionalLocalLockfilePath(
      "/repo",
      marker("@swamp/s3-datastore", false),
      "/repo/extensions/models/upstream_extensions.json",
      unset,
    ),
    undefined,
  );
});

Deno.test("transitionalLocalLockfilePath: undefined when both paths are the same file", () => {
  assertEquals(
    transitionalLocalLockfilePath(
      "/repo",
      marker("@swamp/s3-datastore"),
      "/repo/.swamp/config/upstream_extensions.json",
      unset,
    ),
    undefined,
  );
});

Deno.test("readInstalledEntries: merges the local lockfile, resolved entries win", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const resolvedPath = join(dir, "resolved.json");
    const localPath = join(dir, "local.json");
    await Deno.writeTextFile(
      resolvedPath,
      JSON.stringify({ "@a/one": entry("2"), "@a/both": entry("team") }),
    );
    await Deno.writeTextFile(
      localPath,
      JSON.stringify({ "@a/local": entry("1"), "@a/both": entry("local") }),
    );
    const { entries, localOnly } = await readInstalledEntries(
      resolvedPath,
      localPath,
    );
    assertEquals(Object.keys(entries).sort(), [
      "@a/both",
      "@a/local",
      "@a/one",
    ]);
    assertEquals(entries["@a/both"].version, "team");
    assertEquals([...localOnly], ["@a/local"]);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("readInstalledEntries: missing files read as empty, a corrupt local file is skipped", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const localPath = join(dir, "local.json");
    await Deno.writeTextFile(localPath, "{not json");
    const { entries, localOnly } = await readInstalledEntries(
      join(dir, "missing.json"),
      localPath,
    );
    assertEquals(entries, {});
    assertEquals(localOnly.size, 0);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("readInstalledEntries: a local lockfile containing null is skipped", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const resolvedPath = join(dir, "resolved.json");
    const localPath = join(dir, "local.json");
    await Deno.writeTextFile(
      resolvedPath,
      JSON.stringify({ "@ns/team": entry("1.0.0") }),
    );
    await Deno.writeTextFile(localPath, "null\n");
    const { entries, localOnly } = await readInstalledEntries(
      resolvedPath,
      localPath,
    );
    assertEquals(entries, { "@ns/team": entry("1.0.0") });
    assertEquals(localOnly.size, 0);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("transitionalInstalledNames: names only the local lockfile records, or none without one", async () => {
  const repo = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const resolvedPath = join(repo, "cache", "upstream_extensions.json");
    await Deno.mkdir(join(repo, "cache"));
    await Deno.mkdir(join(repo, ".swamp", "config"), { recursive: true });
    await Deno.writeTextFile(
      resolvedPath,
      JSON.stringify({ "@a/team": entry("1"), "@a/both": entry("1") }),
    );
    await Deno.writeTextFile(
      join(repo, ".swamp", "config", "upstream_extensions.json"),
      JSON.stringify({ "@a/auto": entry("1"), "@a/both": entry("2") }),
    );
    assertEquals(
      await transitionalInstalledNames(
        repo,
        marker("@swamp/s3-datastore"),
        resolvedPath,
        unset,
      ),
      ["@a/auto"],
    );
    assertEquals(
      await transitionalInstalledNames(
        repo,
        marker("filesystem"),
        resolvedPath,
        unset,
      ),
      [],
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repo, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repo, { recursive: true });
    }
  }
});

Deno.test("readInstalledEntries: drops a local entry that is not an object", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const localPath = join(dir, "local.json");
    await Deno.writeTextFile(
      localPath,
      JSON.stringify({ "@a/null": null, "@a/list": [], "@a/ok": entry("1") }),
    );
    const { entries, localOnly } = await readInstalledEntries(
      join(dir, "missing.json"),
      localPath,
    );
    assertEquals(Object.keys(entries), ["@a/ok"]);
    assertEquals([...localOnly], ["@a/ok"]);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("isAbsentFromDisk: gone only when the directory and every source file are", async () => {
  const repo = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const skill = ".swamp/pulled-extensions/skills/foo/SKILL.md";
    const withFiles = (...files: string[]) => ({ ...entry("1"), files });
    await Deno.mkdir(join(resolvePulledExtensionsRoot(repo), "@a", "here"), {
      recursive: true,
    });
    await Deno.mkdir(
      join(repo, ".swamp", "pulled-extensions", "skills", "foo"),
      {
        recursive: true,
      },
    );
    await Deno.writeTextFile(join(repo, skill), "x");

    // The directory is present: a truncated tree, not gone.
    assertEquals(await isAbsentFromDisk(repo, "@a/here", withFiles()), false);
    // Only regenerable bundle output remains.
    assertEquals(
      await isAbsentFromDisk(
        repo,
        "@a/gone",
        withFiles(".swamp/bundles/abc/x.js"),
      ),
      true,
    );
    // A tracked file outside the directory survives, which the
    // auto-resolver reports rather than reinstalling over.
    assertEquals(
      await isAbsentFromDisk(repo, "@a/gone", withFiles(skill)),
      false,
    );
    // Names and paths outside the repo are never reported as gone.
    assertEquals(await isAbsentFromDisk(repo, "../../x", withFiles()), false);
    assertEquals(
      await isAbsentFromDisk(repo, "@a/gone", withFiles("/etc/passwd")),
      false,
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repo, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repo, { recursive: true });
    }
  }
});

Deno.test("pathsToRemoveForReinstall: the extension directory, then its skill dirs and stray files", () => {
  const repo = join("/repo", crypto.randomUUID());
  const extensionDir = join(resolvePulledExtensionsRoot(repo), "@a", "x");
  const files = [
    // Inside the extension directory (an unregistered repo's pulled root):
    // covered by deleting it.
    ".swamp/pulled-extensions/@a/x/models/m.ts",
    // Two files of one skill collapse to its skill dir.
    ".swamp/pulled-extensions/skills/foo/SKILL.md",
    ".swamp/pulled-extensions/skills/foo/ref.md",
    // Regenerable, and outside the repo: never listed.
    ".swamp/bundles/abc/m.js",
    "../outside.ts",
    // A stray file elsewhere in the repo is listed itself.
    "extensions/models/stray.ts",
  ];
  const paths = pathsToRemoveForReinstall(repo, "@a/x", {
    "@a/x": { ...entry("1"), files },
  });
  assertEquals(paths.length, 3);
  assertPathEquals(paths[0], extensionDir.slice(repo.length + 1));
  assertPathEquals(paths[1], ".swamp/pulled-extensions/skills/foo");
  assertPathEquals(paths[2], "extensions/models/stray.ts");
  assertEquals(
    pathsToRemoveForReinstall(repo, "../../x", { "../../x": entry("1") }),
    [],
  );
});

Deno.test("pathsToRemoveForReinstall: lists only its own files in a skill dir another extension claims", () => {
  const repo = join("/repo", crypto.randomUUID());
  const installed = {
    "@a/x": {
      ...entry("1"),
      files: [
        ".swamp/pulled-extensions/skills/shared/SKILL.md",
        ".swamp/pulled-extensions/skills/own/SKILL.md",
      ],
    },
    // Claims the shared dir, in a different case and with backslashes,
    // as a lockfile written on Windows would.
    "@t/y": {
      ...entry("1"),
      files: [".swamp\\pulled-extensions\\skills\\SHARED\\other.md"],
    },
    "@t/malformed": null,
  };
  const paths = pathsToRemoveForReinstall(repo, "@a/x", installed);
  assertEquals(paths.length, 3);
  assertPathEquals(paths[1], ".swamp/pulled-extensions/skills/shared/SKILL.md");
  assertPathEquals(paths[2], ".swamp/pulled-extensions/skills/own");
});
