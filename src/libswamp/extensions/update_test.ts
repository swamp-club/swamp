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

import { assertEquals } from "@std/assert/equals";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  extensionUpdate,
  type ExtensionUpdateDeps,
  type ExtensionUpdateEvent,
  type ExtensionUpdateInput,
} from "./update.ts";

function makeDeps(
  overrides: Partial<ExtensionUpdateDeps> = {},
): ExtensionUpdateDeps {
  return {
    readUpstreamExtensions: () => Promise.resolve({}),
    getExtension: () => Promise.resolve(null),
    installExtension: () => Promise.resolve(undefined),
    ...overrides,
  };
}

function makeCtx() {
  return createLibSwampContext();
}

Deno.test("extensionUpdate: no extensions installed yields no_extensions", async () => {
  const deps = makeDeps();
  const input: ExtensionUpdateInput = { checkOnly: false };

  const events = await collect<ExtensionUpdateEvent>(
    extensionUpdate(makeCtx(), deps, input),
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "no_extensions");
});

Deno.test("extensionUpdate: specific extension not installed yields error", async () => {
  const deps = makeDeps({
    readUpstreamExtensions: () =>
      Promise.resolve({ "@ns/other": { version: "2026.01.01.1" } }),
  });
  const input: ExtensionUpdateInput = {
    extensionName: "@ns/missing",
    checkOnly: false,
  };

  const events = await collect<ExtensionUpdateEvent>(
    extensionUpdate(makeCtx(), deps, input),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "extension_not_installed");
  if (events[0].kind === "extension_not_installed") {
    assertEquals(events[0].name, "@ns/missing");
  }
  assertEquals(events[1].kind, "error");
});

Deno.test("extensionUpdate: check mode with updates available", async () => {
  const deps = makeDeps({
    readUpstreamExtensions: () =>
      Promise.resolve({
        "@ns/a": { version: "2026.01.01.1" },
        "@ns/b": { version: "2026.02.01.1" },
      }),
    getExtension: (name) => {
      if (name === "@ns/a") {
        return Promise.resolve({ latestVersion: "2026.03.01.1" });
      }
      return Promise.resolve({ latestVersion: "2026.02.01.1" });
    },
  });
  const input: ExtensionUpdateInput = { checkOnly: true };

  const events = await collect<ExtensionUpdateEvent>(
    extensionUpdate(makeCtx(), deps, input),
  );

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.mode, "check");
    const ext = completed.data.extensions;
    assertEquals(ext.length, 2);
    const aStatus = ext.find((e) => e.name === "@ns/a");
    assertEquals(aStatus?.status, "update_available");
    const bStatus = ext.find((e) => e.name === "@ns/b");
    assertEquals(bStatus?.status, "up_to_date");
  }
});

Deno.test("extensionUpdate: check mode all up to date", async () => {
  const deps = makeDeps({
    readUpstreamExtensions: () =>
      Promise.resolve({ "@ns/a": { version: "2026.02.01.1" } }),
    getExtension: () => Promise.resolve({ latestVersion: "2026.02.01.1" }),
  });
  const input: ExtensionUpdateInput = { checkOnly: true };

  const events = await collect<ExtensionUpdateEvent>(
    extensionUpdate(makeCtx(), deps, input),
  );

  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.mode, "check");
    assertEquals(completed.data.summary.upToDate, 1);
    assertEquals(completed.data.summary.updated, 0);
  }
});

Deno.test("extensionUpdate: update mode successfully updates", async () => {
  const installed: string[] = [];
  const deps = makeDeps({
    readUpstreamExtensions: () =>
      Promise.resolve({ "@ns/a": { version: "2026.01.01.1" } }),
    getExtension: () => Promise.resolve({ latestVersion: "2026.03.01.1" }),
    installExtension: (name, version) => {
      installed.push(`${name}@${version}`);
      return Promise.resolve(undefined);
    },
  });
  const input: ExtensionUpdateInput = { checkOnly: false };

  const events = await collect<ExtensionUpdateEvent>(
    extensionUpdate(makeCtx(), deps, input),
  );

  assertEquals(installed, ["@ns/a@2026.03.01.1"]);

  const updating = events.find((e) => e.kind === "updating");
  if (updating?.kind === "updating") {
    assertEquals(updating.name, "@ns/a");
    assertEquals(updating.from, "2026.01.01.1");
    assertEquals(updating.to, "2026.03.01.1");
  }

  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.mode, "update");
    assertEquals(completed.data.summary.updated, 1);
    assertEquals(completed.data.extensions[0].status, "updated");
  }
});

Deno.test("extensionUpdate: update mode with install failure", async () => {
  const deps = makeDeps({
    readUpstreamExtensions: () =>
      Promise.resolve({ "@ns/a": { version: "2026.01.01.1" } }),
    getExtension: () => Promise.resolve({ latestVersion: "2026.03.01.1" }),
    installExtension: () => {
      return Promise.reject(new Error("Network timeout"));
    },
  });
  const input: ExtensionUpdateInput = { checkOnly: false };

  const events = await collect<ExtensionUpdateEvent>(
    extensionUpdate(makeCtx(), deps, input),
  );

  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.mode, "update");
    assertEquals(completed.data.summary.failed, 1);
    assertEquals(completed.data.extensions[0].status, "failed");
  }
});

Deno.test("extensionUpdate: registry fetch failure records not_found", async () => {
  const deps = makeDeps({
    readUpstreamExtensions: () =>
      Promise.resolve({ "@ns/a": { version: "2026.01.01.1" } }),
    getExtension: () => Promise.resolve(null),
  });
  const input: ExtensionUpdateInput = { checkOnly: true };

  const events = await collect<ExtensionUpdateEvent>(
    extensionUpdate(makeCtx(), deps, input),
  );

  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.extensions[0].status, "not_found");
    assertEquals(completed.data.summary.failed, 1);
  }
});

import type { InstallResult } from "./pull.ts";

function buildInstallResult(
  name: string,
  version: string,
  pruned: string[],
): InstallResult {
  return {
    name,
    version,
    description: undefined,
    extractedFiles: [`.swamp/pulled-extensions/${name}/models/main.ts`],
    integrityStatus: "verified",
    repository: undefined,
    platforms: [],
    safetyWarnings: [],
    conflicts: [],
    missingSourceFiles: [],
    hasSkills: false,
    hasSkillScripts: false,
    skillFiles: [],
    dependencyResults: [],
    pruned,
  };
}

Deno.test(
  "extensionUpdate: emits orphans-pruned event when installExtension returns pruned paths",
  async () => {
    const deps = makeDeps({
      readUpstreamExtensions: () =>
        Promise.resolve({ "@ns/a": { version: "2026.01.01.1" } }),
      getExtension: () => Promise.resolve({ latestVersion: "2026.03.01.1" }),
      installExtension: (name, version) =>
        Promise.resolve(
          buildInstallResult(name, version, [
            ".swamp/pulled-extensions/@ns/a/models/old_helper.ts",
          ]),
        ),
    });
    const input: ExtensionUpdateInput = { checkOnly: false };

    const events = await collect<ExtensionUpdateEvent>(
      extensionUpdate(makeCtx(), deps, input),
    );

    const orphansPruned = events.find((e) => e.kind === "orphans-pruned");
    if (orphansPruned?.kind !== "orphans-pruned") {
      throw new Error(
        `expected orphans-pruned event, got: ${
          events.map((e) => e.kind).join(", ")
        }`,
      );
    }
    assertEquals(orphansPruned.name, "@ns/a");
    assertEquals(orphansPruned.from, "2026.01.01.1");
    assertEquals(orphansPruned.to, "2026.03.01.1");
    assertEquals(orphansPruned.paths, [
      ".swamp/pulled-extensions/@ns/a/models/old_helper.ts",
    ]);
  },
);

Deno.test(
  "extensionUpdate: NO orphans-pruned event when result has empty pruned list",
  async () => {
    const deps = makeDeps({
      readUpstreamExtensions: () =>
        Promise.resolve({ "@ns/a": { version: "2026.01.01.1" } }),
      getExtension: () => Promise.resolve({ latestVersion: "2026.03.01.1" }),
      installExtension: (name, version) =>
        Promise.resolve(buildInstallResult(name, version, [])),
    });
    const input: ExtensionUpdateInput = { checkOnly: false };

    const events = await collect<ExtensionUpdateEvent>(
      extensionUpdate(makeCtx(), deps, input),
    );

    assertEquals(
      events.find((e) => e.kind === "orphans-pruned"),
      undefined,
    );
  },
);
