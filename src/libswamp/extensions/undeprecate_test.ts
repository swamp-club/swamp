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
  extensionUndeprecate,
  type ExtensionUndeprecateDeps,
  type ExtensionUndeprecateEvent,
  type ExtensionUndeprecateInput,
  extensionUndeprecatePreview,
} from "./undeprecate.ts";

function fakeDeps(
  overrides?: Partial<ExtensionUndeprecateDeps>,
): ExtensionUndeprecateDeps {
  return {
    loadCredentials: () =>
      Promise.resolve({
        serverUrl: "https://test.club",
        apiKey: "key-123",
      }),
    undeprecateExtension: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("extensionUndeprecate: undeprecates extension", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionUndeprecateInput = {
    extensionName: "@test/ext",
  };
  await assertCompletes<ExtensionUndeprecateEvent>(
    extensionUndeprecate(ctx, deps, input),
    {
      kind: "completed",
      data: { name: "@test/ext" },
    },
  );
});

Deno.test("extensionUndeprecate: errors when not authenticated", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps({
    loadCredentials: () => Promise.resolve(null),
  });
  const input: ExtensionUndeprecateInput = {
    extensionName: "@test/ext",
  };
  await assertErrors<ExtensionUndeprecateEvent>(
    extensionUndeprecate(ctx, deps, input),
    "not_authenticated",
  );
});

Deno.test("extensionUndeprecatePreview: rejects invalid extension name", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionUndeprecateInput = {
    extensionName: "invalid-name",
  };
  try {
    await extensionUndeprecatePreview(ctx, deps, input);
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "validation_failed");
  }
});

Deno.test("extensionUndeprecatePreview: rejects when not authenticated", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps({
    loadCredentials: () => Promise.resolve(null),
  });
  const input: ExtensionUndeprecateInput = {
    extensionName: "@test/ext",
  };
  try {
    await extensionUndeprecatePreview(ctx, deps, input);
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "not_authenticated");
  }
});
