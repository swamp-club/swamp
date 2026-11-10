#!/usr/bin/env -S deno run -A

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

import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  restoreBuildState,
  runStampedBuild,
  stampBuildInfo,
  VERSION_FILE,
} from "./compile.ts";

const buildInfoPath = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  VERSION_FILE,
);

const VERSION_LINE = /^export const VERSION = .*$/m;
const GIT_SHA_LINE = /^export const GIT_SHA = .*$/m;

Deno.test("stampBuildInfo: stamps both constants in the real build info file", async () => {
  const source = await Deno.readTextFile(buildInfoPath);

  const stamped = stampBuildInfo(source, {
    version: "20990101.000000.0-sha.abc1234",
    sha: "abc1234",
  });

  assertEquals(
    stamped.match(VERSION_LINE)?.[0],
    'export const VERSION = "20990101.000000.0-sha.abc1234";',
  );
  assertEquals(
    stamped.match(GIT_SHA_LINE)?.[0],
    'export const GIT_SHA = "abc1234";',
  );
});

Deno.test("stampBuildInfo: leaves a constant whose value is not given untouched", async () => {
  const source = await Deno.readTextFile(buildInfoPath);

  const shaOnly = stampBuildInfo(source, { sha: "abc1234" });
  assertEquals(
    shaOnly.match(VERSION_LINE)?.[0],
    source.match(VERSION_LINE)?.[0],
  );
  assertNotEquals(shaOnly, source);

  assertEquals(stampBuildInfo(source, {}), source);
});

Deno.test("stampBuildInfo: throws when a requested constant is missing", () => {
  const noVersion = 'export const GIT_SHA = "";\n';
  const noSha = 'export const VERSION = "1.0.0";\n';

  assertThrows(
    () => stampBuildInfo(noVersion, { version: "2.0.0" }),
    Error,
    "no VERSION constant",
  );
  assertThrows(
    () => stampBuildInfo(noSha, { sha: "abc1234" }),
    Error,
    "no GIT_SHA constant",
  );
});

function recordingSteps(
  build: () => Promise<boolean>,
  stamp: () => Promise<void> = () => Promise.resolve(),
) {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      stamp: async () => {
        calls.push("stamp");
        await stamp();
      },
      build: async () => {
        calls.push("build");
        return await build();
      },
      restore: () => {
        calls.push("restore");
        return Promise.resolve();
      },
    },
  };
}

Deno.test("runStampedBuild: restores and reports failure when the build fails", async () => {
  const { calls, steps } = recordingSteps(() => Promise.resolve(false));
  assertEquals(await runStampedBuild(steps), false);
  assertEquals(calls, ["stamp", "build", "restore"]);
});

Deno.test("runStampedBuild: restores and reports success when the build succeeds", async () => {
  const { calls, steps } = recordingSteps(() => Promise.resolve(true));
  assertEquals(await runStampedBuild(steps), true);
  assertEquals(calls, ["stamp", "build", "restore"]);
});

Deno.test("runStampedBuild: restores and rethrows when the build throws", async () => {
  const { calls, steps } = recordingSteps(() =>
    Promise.reject(new Error("download failed"))
  );
  await assertRejects(() => runStampedBuild(steps), Error, "download failed");
  assertEquals(calls, ["stamp", "build", "restore"]);
});

Deno.test("runStampedBuild: restores without building when the stamp throws", async () => {
  const { calls, steps } = recordingSteps(
    () => Promise.resolve(true),
    () => Promise.reject(new Error("stamp failed")),
  );
  await assertRejects(() => runStampedBuild(steps), Error, "stamp failed");
  assertEquals(calls, ["stamp", "restore"]);
});

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true).catch(() => false);
}

async function withBuildTree(
  run: (paths: { versionFile: string; denoDir: string }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "compile-restore-" });
  try {
    const versionFile = join(root, "build_info.ts");
    const denoDir = join(root, "resources", "deno");
    await Deno.writeTextFile(versionFile, 'export const GIT_SHA = "stamped";');
    await Deno.mkdir(denoDir, { recursive: true });
    await Deno.writeTextFile(join(denoDir, "version.txt"), "2.9.8");
    await run({ versionFile, denoDir });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("restoreBuildState: rewrites the version file and removes the deno resources", async () => {
  await withBuildTree(async ({ versionFile, denoDir }) => {
    await restoreBuildState(versionFile, "original", denoDir);
    assertEquals(await Deno.readTextFile(versionFile), "original");
    assertEquals(await exists(denoDir), false);
  });
});

Deno.test("restoreBuildState: leaves the version file alone when nothing was stamped", async () => {
  await withBuildTree(async ({ versionFile, denoDir }) => {
    await restoreBuildState(versionFile, undefined, denoDir);
    assertEquals(
      await Deno.readTextFile(versionFile),
      'export const GIT_SHA = "stamped";',
    );
    assertEquals(await exists(denoDir), false);
  });
});

Deno.test("restoreBuildState: tolerates missing deno resources", async () => {
  await withBuildTree(async ({ versionFile, denoDir }) => {
    await Deno.remove(denoDir, { recursive: true });
    await restoreBuildState(versionFile, "original", denoDir);
    assertEquals(await Deno.readTextFile(versionFile), "original");
  });
});

Deno.test("restoreBuildState: removes the deno resources when the version file write fails", async () => {
  await withBuildTree(async ({ versionFile, denoDir }) => {
    await Deno.remove(versionFile);
    await Deno.mkdir(versionFile);
    // the error class differs by platform, so only the rejection is asserted
    await assertRejects(() =>
      restoreBuildState(versionFile, "original", denoDir)
    );
    assertEquals(await exists(denoDir), false);
  });
});
