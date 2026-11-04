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

import { assertEquals, assertRejects } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { UserError } from "../../domain/errors.ts";
import { assertCompletes, assertErrors } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createExtensionVisibilityDeps,
  type ExtensionVisibility,
  extensionVisibility,
  type ExtensionVisibilityDeps,
  type ExtensionVisibilityEvent,
  type ExtensionVisibilityInput,
} from "./visibility.ts";

function makeDeps(opts: {
  current?: ExtensionVisibility | null;
  applied?: ExtensionVisibility;
  credentials?: boolean;
  sets?: ExtensionVisibility[];
}): ExtensionVisibilityDeps {
  return {
    loadCredentials: () =>
      Promise.resolve(
        opts.credentials === false
          ? null
          : { serverUrl: "https://registry.test", apiKey: "k" },
      ),
    getVisibility: () =>
      Promise.resolve(opts.current === undefined ? "private" : opts.current),
    setVisibility: (_url, _name, visibility) => {
      opts.sets?.push(visibility);
      return Promise.resolve(opts.applied ?? visibility);
    },
  };
}

function input(
  overrides: Partial<ExtensionVisibilityInput> = {},
): ExtensionVisibilityInput {
  return {
    extensionName: "@myorg/ext",
    target: null,
    dryRun: false,
    ...overrides,
  };
}

const ctx = createLibSwampContext();

Deno.test("extensionVisibility: reading reports the current value without setting", async () => {
  const sets: ExtensionVisibility[] = [];
  await assertCompletes<ExtensionVisibilityEvent>(
    extensionVisibility(ctx, makeDeps({ current: "private", sets }), input()),
    {
      kind: "completed",
      data: {
        name: "@myorg/ext",
        before: "private",
        after: "private",
        changed: false,
        dryRun: false,
      },
    },
  );
  assertEquals(sets, []);
});

Deno.test("extensionVisibility: setting public reports before and the registry's after", async () => {
  const sets: ExtensionVisibility[] = [];
  await assertCompletes<ExtensionVisibilityEvent>(
    extensionVisibility(
      ctx,
      makeDeps({ current: "private", sets }),
      input({ target: "public" }),
    ),
    {
      kind: "completed",
      data: {
        name: "@myorg/ext",
        before: "private",
        after: "public",
        changed: true,
        dryRun: false,
      },
    },
  );
  assertEquals(sets, ["public"]);
});

Deno.test("extensionVisibility: after comes from the registry, and a kept value reports what was requested", async () => {
  await assertCompletes<ExtensionVisibilityEvent>(
    extensionVisibility(
      ctx,
      makeDeps({ current: "private", applied: "private" }),
      input({ target: "public" }),
    ),
    {
      kind: "completed",
      data: {
        name: "@myorg/ext",
        before: "private",
        after: "private",
        changed: false,
        dryRun: false,
        requested: "public",
      },
    },
  );
});

Deno.test("extensionVisibility: an extension already at the target is not set again", async () => {
  const sets: ExtensionVisibility[] = [];
  await assertCompletes<ExtensionVisibilityEvent>(
    extensionVisibility(
      ctx,
      makeDeps({ current: "public", sets }),
      input({ target: "public" }),
    ),
    {
      kind: "completed",
      data: {
        name: "@myorg/ext",
        before: "public",
        after: "public",
        changed: false,
        dryRun: false,
      },
    },
  );
  assertEquals(sets, []);
});

Deno.test("extensionVisibility: a dry run reports the would-be value without setting", async () => {
  const sets: ExtensionVisibility[] = [];
  await assertCompletes<ExtensionVisibilityEvent>(
    extensionVisibility(
      ctx,
      makeDeps({ current: "private", sets }),
      input({ target: "public", dryRun: true }),
    ),
    {
      kind: "completed",
      data: {
        name: "@myorg/ext",
        before: "private",
        after: "public",
        changed: true,
        dryRun: true,
      },
    },
  );
  assertEquals(sets, []);
});

Deno.test("extensionVisibility: --dry-run without a target is refused", async () => {
  await assertErrors(
    extensionVisibility(ctx, makeDeps({}), input({ dryRun: true })),
    "validation_failed",
  );
});

Deno.test("extensionVisibility: an invalid name is refused", async () => {
  await assertErrors(
    extensionVisibility(
      ctx,
      makeDeps({}),
      input({ extensionName: "myorg/ext" }),
    ),
    "validation_failed",
  );
});

Deno.test("extensionVisibility: no credentials is not authenticated", async () => {
  await assertErrors(
    extensionVisibility(ctx, makeDeps({ credentials: false }), input()),
    "not_authenticated",
  );
});

Deno.test("extensionVisibility: an extension the registry does not show is not found", async () => {
  const sets: ExtensionVisibility[] = [];
  await assertErrors(
    extensionVisibility(
      ctx,
      makeDeps({ current: null, sets }),
      input({ target: "public" }),
    ),
    "not_found",
  );
  assertEquals(sets, []);
});

Deno.test("createExtensionVisibilityDeps: a registry response without isPrivate is refused, not read as public", async () => {
  const deps = createExtensionVisibilityDeps();
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ name: "@myorg/ext" }), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      assertRejects(
        () => deps.getVisibility("https://registry.test", "@myorg/ext", "k"),
        UserError,
        "did not report this extension's visibility",
      ),
  );
});

Deno.test("createExtensionVisibilityDeps: a reported isPrivate maps to the visibility", async () => {
  const deps = createExtensionVisibilityDeps();
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ name: "@myorg/ext", isPrivate: true }), {
        headers: { "content-type": "application/json" },
      }),
    async () => {
      assertEquals(
        await deps.getVisibility("https://registry.test", "@myorg/ext", "k"),
        "private",
      );
    },
  );
});
