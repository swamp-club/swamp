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
import { assertCompletes, assertErrors } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  extensionUnyank,
  type ExtensionUnyankDeps,
  type ExtensionUnyankEvent,
  type ExtensionUnyankInput,
  extensionUnyankPreview,
} from "./unyank.ts";

function fakeDeps(
  overrides?: Partial<ExtensionUnyankDeps>,
): ExtensionUnyankDeps {
  return {
    loadCredentials: () =>
      Promise.resolve({
        serverUrl: "https://test.club",
        apiKey: "key-123",
      }),
    unyankExtension: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("extensionUnyank: unyanks specific version", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionUnyankInput = {
    extensionName: "@test/ext",
    version: "2025.01",
    reason: "recovered",
  };
  await assertCompletes<ExtensionUnyankEvent>(
    extensionUnyank(ctx, deps, input),
    {
      kind: "completed",
      data: { name: "@test/ext", version: "2025.01", reason: "recovered" },
    },
  );
});

Deno.test("extensionUnyank: unyanks extension when version is null", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionUnyankInput = {
    extensionName: "@test/ext",
    version: null,
    reason: "restoring name",
  };
  await assertCompletes<ExtensionUnyankEvent>(
    extensionUnyank(ctx, deps, input),
    {
      kind: "completed",
      data: { name: "@test/ext", version: null, reason: "restoring name" },
    },
  );
});

Deno.test("extensionUnyank: accepts null reason", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionUnyankInput = {
    extensionName: "@test/ext",
    version: "2025.01",
    reason: null,
  };
  await assertCompletes<ExtensionUnyankEvent>(
    extensionUnyank(ctx, deps, input),
    {
      kind: "completed",
      data: { name: "@test/ext", version: "2025.01", reason: null },
    },
  );
});

Deno.test("extensionUnyank: errors when not authenticated", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps({
    loadCredentials: () => Promise.resolve(null),
  });
  const input: ExtensionUnyankInput = {
    extensionName: "@test/ext",
    version: "2025.01",
    reason: "recovered",
  };
  await assertErrors<ExtensionUnyankEvent>(
    extensionUnyank(ctx, deps, input),
    "not_authenticated",
  );
});

Deno.test("extensionUnyankPreview: rejects invalid extension name", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionUnyankInput = {
    extensionName: "invalid-name",
    version: "2025.01",
    reason: "recovered",
  };
  try {
    await extensionUnyankPreview(ctx, deps, input);
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "validation_failed");
  }
});

Deno.test("extensionUnyankPreview: rejects when not authenticated", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps({
    loadCredentials: () => Promise.resolve(null),
  });
  const input: ExtensionUnyankInput = {
    extensionName: "@test/ext",
    version: "2025.01",
    reason: "recovered",
  };
  try {
    await extensionUnyankPreview(ctx, deps, input);
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "not_authenticated");
  }
});
