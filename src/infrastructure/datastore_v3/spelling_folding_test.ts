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
  probeSpellingFolding,
  SPELLING_PROBE_FILE,
  spellingFoldingOf,
} from "./spelling_folding.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-spelling-folding-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Whether an upper-case or decomposed spelling reaches a file in `dir`. */
async function folds(dir: string): Promise<boolean> {
  const name = "oracle-é";
  await Deno.writeTextFile(join(dir, name), "");
  try {
    for (const spelling of [name.toUpperCase(), name.normalize("NFD")]) {
      try {
        await Deno.lstat(join(dir, spelling));
        return true;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return false;
  } finally {
    await Deno.remove(join(dir, name));
  }
}

function fakeStat(devices: Record<string, number>) {
  return (path: string): Promise<Deno.FileInfo> => {
    const dev = devices[path];
    if (dev === undefined) {
      return Promise.reject(new Deno.errors.NotFound(path));
    }
    return Promise.resolve({ dev } as Deno.FileInfo);
  };
}

Deno.test("probeSpellingFolding: off only where no other spelling reaches a file, and leaves no file behind", async () => {
  await withTempDir(async (dir) => {
    const mode = await probeSpellingFolding(dir);
    assertEquals(mode === "off", !await folds(dir));
    assertEquals(await Array.fromAsync(Deno.readDir(dir)), []);
  });
});

Deno.test("probeSpellingFolding: writes over a probe file a crash left", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, SPELLING_PROBE_FILE), "left");
    const mode = await probeSpellingFolding(dir);
    assertEquals(mode === "off", !await folds(dir));
    assertEquals(await Array.fromAsync(Deno.readDir(dir)), []);
  });
});

Deno.test("probeSpellingFolding: list where the probe cannot be written", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await probeSpellingFolding(join(dir, "missing")), "list");
  });
});

Deno.test("spellingFoldingOf: the probed mode on the probed device, list on another", async () => {
  const stat = fakeStat({ "/repo/.swamp": 1, "/repo/.swamp/state": 1 });
  assertEquals(
    await spellingFoldingOf("/repo/.swamp", "/repo/.swamp/state", "off", stat),
    "off",
  );
  assertEquals(
    await spellingFoldingOf(
      "/repo/.swamp",
      "/repo/.swamp/state",
      "canonical",
      stat,
    ),
    "canonical",
  );
  const mounted = fakeStat({ "/repo/.swamp": 2, "/repo/.swamp/state": 1 });
  assertEquals(
    await spellingFoldingOf(
      "/repo/.swamp",
      "/repo/.swamp/state",
      "off",
      mounted,
    ),
    "list",
  );
});

Deno.test("spellingFoldingOf: a root not there yet is judged by its nearest ancestor", async () => {
  const root = join("/repo", ".swamp", "alpha");
  const stat = fakeStat({
    [join("/repo", ".swamp")]: 1,
    [join("/repo", ".swamp", "state")]: 1,
  });
  assertEquals(
    await spellingFoldingOf(
      root,
      join("/repo", ".swamp", "state"),
      "off",
      stat,
    ),
    "off",
  );
});

Deno.test("spellingFoldingOf: list when a device cannot be read, or the probe gave list", async () => {
  const failing = (_path: string): Promise<Deno.FileInfo> =>
    Promise.reject(new Deno.errors.PermissionDenied("denied"));
  assertEquals(
    await spellingFoldingOf(
      "/repo/.swamp",
      "/repo/.swamp/state",
      "off",
      failing,
    ),
    "list",
  );
  assertEquals(
    await spellingFoldingOf(
      "/repo/.swamp",
      "/repo/.swamp/state",
      "list",
      fakeStat({ "/repo/.swamp": 1, "/repo/.swamp/state": 1 }),
    ),
    "list",
  );
});
