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
import { assertCompletes, assertErrors, collect } from "../testing.ts";
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
    findPublishedVersion: () => Promise.resolve(null),
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

// ── Promote from a manifest (swamp-club#2939, swamp-club#2751) ─────────

const MANIFEST_INPUT: ExtensionPromoteInput = {
  extensionName: "@test/ext",
  version: "2026.06.10.1",
  toChannel: "stable",
  resolveFromChannel: true,
};

Deno.test("extensionPromote: from a manifest, reports the channel found and promotes from it", async () => {
  const promoted: string[] = [];
  const deps = fakeDeps({
    findPublishedVersion: () =>
      Promise.resolve({ version: "2026.06.10.1", channel: "beta" }),
    promoteExtension: (_url, name, version, toChannel) => {
      promoted.push(`${name}@${version}->${toChannel}`);
      return Promise.resolve({
        name,
        version,
        previousChannel: "beta",
        channel: toChannel,
        message: "Promoted",
      });
    },
  });
  const events = await collect(
    extensionPromote(createLibSwampContext(), deps, MANIFEST_INPUT),
  );
  assertEquals(events.map((e) => e.kind), [
    "promoting",
    "resolved",
    "completed",
  ]);
  assertEquals(events[1], {
    kind: "resolved",
    name: "@test/ext",
    version: "2026.06.10.1",
    fromChannel: "beta",
    toChannel: "stable",
  });
  assertEquals(promoted, ["@test/ext@2026.06.10.1->stable"]);
});

Deno.test("extensionPromote: from a manifest, an unpublished version is nothing to promote", async () => {
  let promoteCalls = 0;
  const deps = fakeDeps({
    promoteExtension: () => {
      promoteCalls++;
      return Promise.reject(new Error("unreachable"));
    },
  });
  const error = await assertErrors<ExtensionPromoteEvent>(
    extensionPromote(createLibSwampContext(), deps, MANIFEST_INPUT),
    "validation_failed",
  );
  assertEquals(
    error.message,
    "Nothing to promote: @test/ext@2026.06.10.1 is not published on any channel.",
  );
  assertEquals(promoteCalls, 0);
});

Deno.test("extensionPromote: from a manifest, a version already at or above the target is nothing to promote", async () => {
  for (const channel of ["stable", "rc"]) {
    const deps = fakeDeps({
      findPublishedVersion: () =>
        Promise.resolve({ version: "2026.06.10.1", channel }),
      promoteExtension: () => Promise.reject(new Error("unreachable")),
    });
    const error = await assertErrors<ExtensionPromoteEvent>(
      extensionPromote(createLibSwampContext(), deps, {
        ...MANIFEST_INPUT,
        toChannel: "rc",
      }),
      "validation_failed",
    );
    assertEquals(
      error.message,
      `Nothing to promote: @test/ext@2026.06.10.1 is on channel '${channel}', which is not below 'rc'.`,
    );
  }
});

Deno.test("extensionPromote: by name and version, never asks the registry where the version is", async () => {
  let lookups = 0;
  const deps = fakeDeps({
    findPublishedVersion: () => {
      lookups++;
      return Promise.resolve(null);
    },
  });
  const events = await collect(
    extensionPromote(createLibSwampContext(), deps, {
      extensionName: "@test/ext",
      version: "2026.06.10.1",
      toChannel: "rc",
    }),
  );
  assertEquals(events.map((e) => e.kind), ["promoting", "completed"]);
  assertEquals(lookups, 0);
});
