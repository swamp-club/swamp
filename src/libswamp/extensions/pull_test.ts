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

import { assertEquals, assertThrows } from "@std/assert";
import { assertStringIncludes } from "@std/assert/string-includes";
import { join } from "@std/path";
import {
  computeOrphanDiff,
  extensionPull,
  type ExtensionPullDeps,
  type ExtensionPullEvent,
  type ExtensionRef,
  type InstallContext,
  type InstallResult,
  parseExtensionRef,
  validateExtensionName,
} from "./pull.ts";
import { createLibSwampContext } from "../context.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { UserError } from "../../domain/errors.ts";

Deno.test("parseExtensionRef: parses name without version", () => {
  const ref = parseExtensionRef("@myorg/my-ext");
  assertEquals(ref.name, "@myorg/my-ext");
  assertEquals(ref.version, null);
});

Deno.test("parseExtensionRef: parses name with version", () => {
  const ref = parseExtensionRef("@myorg/my-ext@2026.02.26.1");
  assertEquals(ref.name, "@myorg/my-ext");
  assertEquals(ref.version, "2026.02.26.1");
});

Deno.test("parseExtensionRef: throws on missing @ prefix", () => {
  assertThrows(
    () => parseExtensionRef("myorg/my-ext"),
    UserError,
    'must start with "@"',
  );
});

Deno.test("parseExtensionRef: throws on empty version", () => {
  assertThrows(
    () => parseExtensionRef("@myorg/my-ext@"),
    UserError,
    "Version cannot be empty",
  );
});

Deno.test("parseExtensionRef: parses nested segments", () => {
  const ref = parseExtensionRef("@myorg/my-ext/sub");
  assertEquals(ref.name, "@myorg/my-ext/sub");
  assertEquals(ref.version, null);
});

Deno.test("validateExtensionName: accepts valid names", () => {
  validateExtensionName("@myorg/my-ext");
  validateExtensionName("@my_org/my_ext");
  validateExtensionName("@myorg/my-ext/sub");
});

Deno.test("validateExtensionName: rejects invalid names", () => {
  assertThrows(
    () => validateExtensionName("myorg/my-ext"),
    UserError,
    "Must match",
  );
  assertThrows(
    () => validateExtensionName("@MyOrg/My-Ext"),
    UserError,
    "Must match",
  );
});

Deno.test("LockfileRepository.writeEntry: writes and updates entries", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const repo = await LockfileRepository.create(lockfilePath);
    await repo.writeEntry("@test/first", "1.0.0", ["a.yaml"]);

    const content = await Deno.readTextFile(lockfilePath);
    const data = JSON.parse(content);
    assertEquals(data["@test/first"].version, "1.0.0");
    assertEquals(data["@test/first"].files, ["a.yaml"]);
    assertStringIncludes(data["@test/first"].pulledAt, "20");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("computeOrphanDiff: empty inputs yield empty diff", () => {
  assertEquals(computeOrphanDiff([], []), []);
  assertEquals(computeOrphanDiff(["a.ts"], []), ["a.ts"]);
  assertEquals(computeOrphanDiff([], ["a.ts"]), []);
});

Deno.test("computeOrphanDiff: identical sets yield no orphans", () => {
  const files = [
    ".swamp/pulled-extensions/@x/y/models/a.ts",
    ".swamp/bundles/abc/a.js",
  ];
  assertEquals(computeOrphanDiff(files, files), []);
});

Deno.test(
  "computeOrphanDiff: paths in old but NOT new are orphans",
  () => {
    // The canonical case from issue 202: v1 had two files, v2 declares
    // only one, so the dropped one is the orphan.
    const oldFiles = [
      ".swamp/pulled-extensions/@hivemq/harvester/kubeconfig/models/harvester/kubeconfig.ts",
      ".swamp/pulled-extensions/@hivemq/harvester/kubeconfig/models/harvester/fetch_kubeconfig.ts",
      ".swamp/bundles/738c72f8/harvester/kubeconfig.js",
      ".swamp/bundles/738c72f8/harvester/fetch_kubeconfig.js",
    ];
    const extractedFiles = [
      ".swamp/pulled-extensions/@hivemq/harvester/kubeconfig/models/harvester/kubeconfig.ts",
      ".swamp/bundles/738c72f8/harvester/kubeconfig.js",
    ];
    const orphans = computeOrphanDiff(oldFiles, extractedFiles);
    assertEquals(orphans.length, 2);
    assertEquals(
      orphans.includes(
        ".swamp/pulled-extensions/@hivemq/harvester/kubeconfig/models/harvester/fetch_kubeconfig.ts",
      ),
      true,
    );
    assertEquals(
      orphans.includes(".swamp/bundles/738c72f8/harvester/fetch_kubeconfig.js"),
      true,
    );
  },
);

Deno.test(
  "computeOrphanDiff: all files dropped — every old path is an orphan",
  () => {
    const oldFiles = ["a.ts", "b.ts", "c.ts"];
    const extractedFiles = ["x.ts"];
    assertEquals(computeOrphanDiff(oldFiles, extractedFiles), [
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  },
);

Deno.test(
  "computeOrphanDiff: order of returned orphans matches old-list order",
  () => {
    // Stability: if two callers compute the same diff, they get the
    // same list. Important for deterministic event output.
    const oldFiles = ["c.ts", "a.ts", "b.ts"];
    const extractedFiles = ["a.ts"];
    assertEquals(computeOrphanDiff(oldFiles, extractedFiles), ["c.ts", "b.ts"]);
  },
);

// ===== Pin 2 (W2) =====
//
// `extensionPull` is one of the 5 KEEP callsites — its
// {@link ExtensionPullEvent} stream API is consumed directly by
// renderers in `presentation/renderers/extension_pull.ts`. Plan v4
// asserts that W2's internal refactor (pull.ts → InstallExtensionService)
// preserves this stream byte-identically. The architecture-agent's Pin 2
// review demanded a regression test that locks in the current shape so
// the W2 refactor cannot quietly leak through the event payload.
//
// This test captures the pre-W2 event sequence + structural shape. As
// commits 2b/2c land (service refactor + phase 8), the test must keep
// passing — that's the proof of byte-identicality.

function makeStubInstallResult(
  ref: ExtensionRef,
  pruned: string[] = [],
): InstallResult {
  return {
    name: ref.name,
    version: ref.version ?? "1.0.0",
    description: undefined,
    extractedFiles: [`.swamp/pulled-extensions/${ref.name}/models/main.ts`],
    integrityStatus: "verified",
    repository: undefined,
    platforms: [],
    safetyWarnings: [],
    binaries: [],
    conflicts: [],
    missingSourceFiles: [],
    hasSkills: false,
    hasSkillScripts: false,
    skillFiles: [],
    dependencyResults: [],
    pruned,
  };
}

async function makeStubDeps(
  installFn: (
    ref: ExtensionRef,
    ctx: InstallContext,
  ) => Promise<InstallResult | undefined>,
): Promise<ExtensionPullDeps> {
  const tmpDir = await Deno.makeTempDir({
    prefix: "swamp_pull_pin2_test_",
  });
  return {
    getExtension: () =>
      Promise.resolve({
        name: "@stub/ext",
        description: "stub",
        latestVersion: "1.0.0",
      }),
    downloadArchive: () => Promise.reject(new Error("stubbed")),
    getChecksum: () => Promise.resolve(null),
    lockfileRepository: await LockfileRepository.create(
      join(tmpDir, "upstream_extensions.json"),
    ),
    skillsDir: join(tmpDir, "skills"),
    repoDir: tmpDir,
    alreadyPulled: new Set(),
    depth: 0,
    installExtensionFn: installFn,
  };
}

async function collectEvents(
  gen: AsyncIterable<ExtensionPullEvent>,
): Promise<ExtensionPullEvent[]> {
  const events: ExtensionPullEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

Deno.test(
  "extensionPull: emits installing → completed for a successful install (Pin 2 baseline)",
  async () => {
    const ref: ExtensionRef = { name: "@stub/ext", version: "1.0.0" };
    const deps = await makeStubDeps(() =>
      Promise.resolve(makeStubInstallResult(ref))
    );

    const events = await collectEvents(
      extensionPull(createLibSwampContext(), deps, { ref, force: false }),
    );

    // Lock in the exact event-kind sequence consumed by renderers.
    assertEquals(events.length, 2);
    assertEquals(events[0].kind, "installing");
    assertEquals(events[1].kind, "completed");

    // Lock in the structural shape of the completed event's payload.
    if (events[1].kind === "completed") {
      assertEquals(events[1].data.name, "@stub/ext");
      assertEquals(events[1].data.version, "1.0.0");
      assertEquals(events[1].data.integrityStatus, "verified");
      assertEquals(events[1].data.pruned, []);
    }

    await Deno.remove(deps.repoDir, { recursive: true });
  },
);

Deno.test(
  "extensionPull: emits installing → orphans-pruned → completed when prior version files are pruned (Pin 2 baseline)",
  async () => {
    const ref: ExtensionRef = { name: "@stub/ext", version: "2.0.0" };
    const prunedPaths = [
      ".swamp/pulled-extensions/@stub/ext/models/old.ts",
    ];
    const deps = await makeStubDeps(() =>
      Promise.resolve(makeStubInstallResult(ref, prunedPaths))
    );

    const events = await collectEvents(
      extensionPull(createLibSwampContext(), deps, { ref, force: false }),
    );

    assertEquals(events.length, 3);
    assertEquals(events[0].kind, "installing");
    assertEquals(events[1].kind, "orphans-pruned");
    assertEquals(events[2].kind, "completed");

    if (events[1].kind === "orphans-pruned") {
      assertEquals(events[1].name, "@stub/ext");
      assertEquals(events[1].version, "2.0.0");
      assertEquals(events[1].paths, prunedPaths);
    }

    await Deno.remove(deps.repoDir, { recursive: true });
  },
);

Deno.test(
  "extensionPull: emits only installing when install short-circuits (alreadyPulled)",
  async () => {
    // The real installExtension returns undefined when ref.name is in
    // alreadyPulled. The generator must NOT yield orphans-pruned or
    // completed in that case — only `installing`.
    const ref: ExtensionRef = { name: "@stub/already-pulled", version: null };
    const deps = await makeStubDeps(() => Promise.resolve(undefined));

    const events = await collectEvents(
      extensionPull(createLibSwampContext(), deps, { ref, force: false }),
    );

    assertEquals(events.length, 1);
    assertEquals(events[0].kind, "installing");

    await Deno.remove(deps.repoDir, { recursive: true });
  },
);

Deno.test(
  "extensionPull: emits deprecated_warning when extension is deprecated",
  async () => {
    const ref: ExtensionRef = { name: "@stub/ext", version: "1.0.0" };
    const deps = await makeStubDeps(() =>
      Promise.resolve(makeStubInstallResult(ref))
    );
    deps.getExtension = () =>
      Promise.resolve({
        name: "@stub/ext",
        description: "stub",
        latestVersion: "1.0.0",
        deprecatedAt: "2026-01-01T00:00:00Z",
        deprecationReason: "Merged into collective",
        supersededBy: "@collective/ext",
      });

    const events = await collectEvents(
      extensionPull(createLibSwampContext(), deps, { ref, force: false }),
    );

    assertEquals(events.length, 3);
    assertEquals(events[0].kind, "installing");
    assertEquals(events[1].kind, "deprecated_warning");
    assertEquals(events[2].kind, "completed");

    if (events[1].kind === "deprecated_warning") {
      assertEquals(events[1].name, "@stub/ext");
      assertEquals(events[1].reason, "Merged into collective");
      assertEquals(events[1].supersededBy, "@collective/ext");
    }

    await Deno.remove(deps.repoDir, { recursive: true }).catch(() => {});
  },
);
