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
import { ensureDir } from "@std/fs";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import {
  doctorExtensions,
  type DoctorExtensionsReport,
  missingExtensionsDoctorDep,
} from "../src/libswamp/extensions/doctor.ts";
import {
  createExtensionListDeps,
  extensionList,
  type ExtensionListEntry,
} from "../src/libswamp/extensions/list.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";

const pulled = (name: string, rel: string) =>
  `.swamp/pulled-extensions/${name}/${rel}`;

async function writeRepoFile(repoDir: string, rel: string): Promise<void> {
  const path = join(repoDir, rel);
  await ensureDir(join(path, ".."));
  await Deno.writeTextFile(path, "x");
}

async function seedRepo(
  repoDir: string,
  lockfilePath: string,
): Promise<void> {
  await ensureDir(join(lockfilePath, ".."));
  await Deno.writeTextFile(
    lockfilePath,
    JSON.stringify({
      "@ex/absent": {
        version: "1.0.0",
        pulledAt: "2026-01-01T00:00:00.000Z",
        files: [pulled("@ex/absent", "manifest.yaml")],
      },
      "@ex/truncated": {
        version: "1.0.0",
        pulledAt: "2026-01-01T00:00:00.000Z",
        files: [
          pulled("@ex/truncated", "manifest.yaml"),
          pulled("@ex/truncated", "models/m.ts"),
        ],
      },
      "@ex/intact": {
        version: "1.0.0",
        pulledAt: "2026-01-01T00:00:00.000Z",
        files: [pulled("@ex/intact", "manifest.yaml")],
      },
    }),
  );
  await writeRepoFile(repoDir, pulled("@ex/truncated", "manifest.yaml"));
  await writeRepoFile(repoDir, pulled("@ex/intact", "manifest.yaml"));
}

async function runDoctor(
  repoDir: string,
  lockfilePath: string,
  localLockfilePath: string | undefined,
): Promise<DoctorExtensionsReport> {
  let report: DoctorExtensionsReport | undefined;
  for await (
    const event of doctorExtensions({
      registries: [],
      lockfileRepository: await LockfileRepository.create(lockfilePath),
      repoDir,
      skillsDirs: [],
      abortSignal: new AbortController().signal,
      ...missingExtensionsDoctorDep(repoDir, lockfilePath, localLockfilePath),
    })
  ) {
    if (event.kind === "completed") report = event.report;
  }
  if (!report) throw new Error("doctor produced no report");
  return report;
}

async function runList(
  repoDir: string,
  lockfilePath: string,
  localLockfilePath: string | undefined,
): Promise<ExtensionListEntry[]> {
  const deps = await createExtensionListDeps(
    repoDir,
    lockfilePath,
    localLockfilePath,
  );
  for await (const event of extensionList(createLibSwampContext(), deps)) {
    if (event.kind === "completed") return event.data.extensions;
  }
  throw new Error("list produced no result");
}

const variants = [
  {
    label: "a team lockfile in the models dir",
    lockfile: (repoDir: string) =>
      join(repoDir, "extensions", "models", "upstream_extensions.json"),
    local: (_repoDir: string) => undefined,
    failing: ["@ex/absent", "@ex/truncated"],
  },
  {
    label: "a managed lockfile with a transitional in-repo one",
    lockfile: (repoDir: string) =>
      join(repoDir, "..", "cache", "upstream_extensions.json"),
    local: (repoDir: string) =>
      join(repoDir, ".swamp", "config", "upstream_extensions.json"),
    failing: ["@ex/truncated"],
  },
];

for (const variant of variants) {
  Deno.test(`doctor and list agree on pinned extensions missing from disk: ${variant.label}`, async () => {
    const root = await Deno.makeTempDir({ prefix: "swamp_missing_pinned_" });
    try {
      const repoDir = join(root, "repo");
      const lockfilePath = variant.lockfile(repoDir);
      const localLockfilePath = variant.local(repoDir);
      await seedRepo(repoDir, lockfilePath);

      const report = await runDoctor(repoDir, lockfilePath, localLockfilePath);
      const listed = await runList(repoDir, lockfilePath, localLockfilePath);

      const fromDoctor = report.missingExtensions.map((m) => [m.name, m.state]);
      const fromList = listed
        .filter((e) => e.missing !== undefined)
        .map((e) => [e.name, e.missing]);
      assertEquals(fromDoctor, [
        ["@ex/absent", "absent"],
        ["@ex/truncated", "truncated"],
      ]);
      assertEquals(fromList, fromDoctor);
      assertEquals(
        report.missingExtensions
          .filter((m) => !m.installsOnNextUse)
          .map((m) => m.name),
        variant.failing,
      );
      assertEquals(report.overallStatus, "fail");
    } finally {
      if (Deno.build.os === "windows") {
        await Deno.remove(root, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(root, { recursive: true });
      }
    }
  });
}
