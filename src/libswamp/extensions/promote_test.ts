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
  extensionPromote,
  type ExtensionPromoteDeps,
  type ExtensionPromoteEvent,
  type ExtensionPromoteInput,
  extensionPromoteValidate,
} from "./promote.ts";

function fakeDeps(
  overrides?: Partial<ExtensionPromoteDeps>,
): ExtensionPromoteDeps {
  return {
    loadCredentials: () =>
      Promise.resolve({
        serverUrl: "https://test.club",
        apiKey: "key-123",
      }),
    promoteExtension: () =>
      Promise.resolve({
        name: "@test/ext",
        version: "2026.06.10.1",
        previousChannel: "beta",
        channel: "rc",
        message: "Promoted",
      }),
    ...overrides,
  };
}

Deno.test("extensionPromote: promotes beta to rc", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps();
  const input: ExtensionPromoteInput = {
    extensionName: "@test/ext",
    version: "2026.06.10.1",
    toChannel: "rc",
  };
  await assertCompletes<ExtensionPromoteEvent>(
    extensionPromote(ctx, deps, input),
    {
      kind: "completed",
      data: {
        name: "@test/ext",
        version: "2026.06.10.1",
        previousChannel: "beta",
        channel: "rc",
        message: "Promoted",
      },
    },
  );
});

Deno.test("extensionPromote: promotes rc to stable", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps({
    promoteExtension: () =>
      Promise.resolve({
        name: "@test/ext",
        version: "2026.06.10.1",
        previousChannel: "rc",
        channel: "stable",
        message: "Promoted to stable",
      }),
  });
  const input: ExtensionPromoteInput = {
    extensionName: "@test/ext",
    version: "2026.06.10.1",
    toChannel: "stable",
  };
  await assertCompletes<ExtensionPromoteEvent>(
    extensionPromote(ctx, deps, input),
    {
      kind: "completed",
      data: {
        name: "@test/ext",
        version: "2026.06.10.1",
        previousChannel: "rc",
        channel: "stable",
        message: "Promoted to stable",
      },
    },
  );
});

Deno.test("extensionPromote: errors when not authenticated", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps({
    loadCredentials: () => Promise.resolve(null),
  });
  const input: ExtensionPromoteInput = {
    extensionName: "@test/ext",
    version: "2026.06.10.1",
    toChannel: "rc",
  };
  await assertErrors<ExtensionPromoteEvent>(
    extensionPromote(ctx, deps, input),
    "not_authenticated",
  );
});

Deno.test("extensionPromoteValidate: rejects invalid extension name", () => {
  try {
    extensionPromoteValidate({
      extensionName: "invalid-name",
      version: "2026.06.10.1",
      toChannel: "rc",
    });
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "validation_failed");
  }
});

Deno.test("extensionPromoteValidate: rejects invalid target channel", () => {
  try {
    extensionPromoteValidate({
      extensionName: "@test/ext",
      version: "2026.06.10.1",
      toChannel: "nightly",
    });
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "validation_failed");
  }
});

Deno.test("extensionPromoteValidate: rejects backward promotion", () => {
  try {
    extensionPromoteValidate({
      extensionName: "@test/ext",
      version: "2026.06.10.1",
      toChannel: "beta",
      fromChannel: "rc",
    });
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "validation_failed");
  }
});

Deno.test("extensionPromoteValidate: rejects beta as target without fromChannel", () => {
  try {
    extensionPromoteValidate({
      extensionName: "@test/ext",
      version: "2026.06.10.1",
      toChannel: "beta",
    });
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "validation_failed");
    assertEquals(
      (error as { message: string }).message.includes(
        "Must be 'rc' or 'stable'",
      ),
      true,
    );
  }
});

Deno.test("extensionPromoteValidate: accepts valid forward promotion", () => {
  // Should not throw
  extensionPromoteValidate({
    extensionName: "@test/ext",
    version: "2026.06.10.1",
    toChannel: "stable",
    fromChannel: "beta",
  });
});

Deno.test("extensionPromote: yields error when API call fails", async () => {
  const ctx = createLibSwampContext();
  const deps = fakeDeps({
    promoteExtension: () => Promise.reject(new Error("Version not found")),
  });
  const input: ExtensionPromoteInput = {
    extensionName: "@test/ext",
    version: "2026.06.10.99",
    toChannel: "rc",
  };
  await assertErrors<ExtensionPromoteEvent>(
    extensionPromote(ctx, deps, input),
    "validation_failed",
  );
});
