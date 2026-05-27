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
  extensionDeprecate,
  type ExtensionDeprecateDeps,
  type ExtensionDeprecateEvent,
  type ExtensionDeprecateInput,
  extensionDeprecatePreview,
} from "./deprecate.ts";

function fakeDeps(
  overrides?: Partial<ExtensionDeprecateDeps>,
): ExtensionDeprecateDeps {
  return {
    loadCredentials: () =>
      Promise.resolve({
        serverUrl: "https://test.club",
        apiKey: "key-123",
      }),
    deprecateExtension: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("extensionDeprecate: deprecates without successor", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionDeprecateInput = {
    extensionName: "@test/ext",
    reason: "no longer maintained",
    supersededBy: null,
  };
  await assertCompletes<ExtensionDeprecateEvent>(
    extensionDeprecate(ctx, deps, input),
    {
      kind: "completed",
      data: {
        name: "@test/ext",
        reason: "no longer maintained",
        supersededBy: null,
      },
    },
  );
});

Deno.test("extensionDeprecate: deprecates with successor", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionDeprecateInput = {
    extensionName: "@jp/libvirt",
    reason: "merged into collective",
    supersededBy: "@bad-at-naming/libvirt",
  };
  await assertCompletes<ExtensionDeprecateEvent>(
    extensionDeprecate(ctx, deps, input),
    {
      kind: "completed",
      data: {
        name: "@jp/libvirt",
        reason: "merged into collective",
        supersededBy: "@bad-at-naming/libvirt",
      },
    },
  );
});

Deno.test("extensionDeprecate: errors when not authenticated", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps({
    loadCredentials: () => Promise.resolve(null),
  });
  const input: ExtensionDeprecateInput = {
    extensionName: "@test/ext",
    reason: "no longer maintained",
    supersededBy: null,
  };
  await assertErrors<ExtensionDeprecateEvent>(
    extensionDeprecate(ctx, deps, input),
    "not_authenticated",
  );
});

Deno.test("extensionDeprecatePreview: rejects invalid extension name", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionDeprecateInput = {
    extensionName: "invalid-name",
    reason: "no longer maintained",
    supersededBy: null,
  };
  try {
    await extensionDeprecatePreview(ctx, deps, input);
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "validation_failed");
  }
});

Deno.test("extensionDeprecatePreview: rejects invalid successor name", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionDeprecateInput = {
    extensionName: "@test/ext",
    reason: "no longer maintained",
    supersededBy: "bad-successor",
  };
  try {
    await extensionDeprecatePreview(ctx, deps, input);
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "validation_failed");
  }
});

Deno.test("extensionDeprecatePreview: rejects when not authenticated", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps({
    loadCredentials: () => Promise.resolve(null),
  });
  const input: ExtensionDeprecateInput = {
    extensionName: "@test/ext",
    reason: "no longer maintained",
    supersededBy: null,
  };
  try {
    await extensionDeprecatePreview(ctx, deps, input);
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "not_authenticated");
  }
});
