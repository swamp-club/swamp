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
import { assertCompletes, assertErrors } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  extensionYank,
  type ExtensionYankDeps,
  type ExtensionYankEvent,
  type ExtensionYankInput,
  extensionYankPreview,
} from "./yank.ts";

function fakeDeps(
  overrides?: Partial<ExtensionYankDeps>,
): ExtensionYankDeps {
  return {
    loadCredentials: () =>
      Promise.resolve({
        serverUrl: "https://test.club",
        apiKey: "key-123",
      }),
    yankExtension: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("extensionYank: yanks specific version", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionYankInput = {
    extensionName: "@test/ext",
    version: "2025.01",
    reason: "broken",
  };
  await assertCompletes<ExtensionYankEvent>(extensionYank(ctx, deps, input), {
    kind: "completed",
    data: { name: "@test/ext", version: "2025.01", reason: "broken" },
  });
});

Deno.test("extensionYank: yanks all versions when version is null", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionYankInput = {
    extensionName: "@test/ext",
    version: null,
    reason: "deprecated",
  };
  await assertCompletes<ExtensionYankEvent>(extensionYank(ctx, deps, input), {
    kind: "completed",
    data: { name: "@test/ext", version: null, reason: "deprecated" },
  });
});

Deno.test("extensionYank: errors when not authenticated", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps({
    loadCredentials: () => Promise.resolve(null),
  });
  const input: ExtensionYankInput = {
    extensionName: "@test/ext",
    version: "2025.01",
    reason: "broken",
  };
  await assertErrors<ExtensionYankEvent>(
    extensionYank(ctx, deps, input),
    "not_authenticated",
  );
});

Deno.test("extensionYankPreview: rejects invalid extension name", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionYankInput = {
    extensionName: "invalid-name",
    version: "2025.01",
    reason: "broken",
  };
  try {
    await extensionYankPreview(ctx, deps, input);
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "validation_failed");
  }
});

Deno.test("extensionYankPreview: rejects when not authenticated", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps({
    loadCredentials: () => Promise.resolve(null),
  });
  const input: ExtensionYankInput = {
    extensionName: "@test/ext",
    version: "2025.01",
    reason: "broken",
  };
  try {
    await extensionYankPreview(ctx, deps, input);
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "not_authenticated");
  }
});
