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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  extensionVersion,
  type ExtensionVersionDeps,
  type ExtensionVersionEvent,
} from "./version.ts";

function makeDeps(
  overrides?: Partial<ExtensionVersionDeps>,
): ExtensionVersionDeps {
  return {
    getLatestVersion: () => Promise.resolve(null),
    ...overrides,
  };
}

function todayPrefix(): string {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}`;
}

Deno.test("extensionVersion: never-published extension returns null published and today.1", async () => {
  const deps = makeDeps();
  const events = await collect<ExtensionVersionEvent>(
    extensionVersion(createLibSwampContext(), deps, {
      extensionName: "@myorg/new-ext",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });

  const completed = events[1] as Extract<
    ExtensionVersionEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.extensionName, "@myorg/new-ext");
  assertEquals(completed.data.currentPublished, null);
  assertEquals(completed.data.publishedAt, null);
  assertEquals(completed.data.nextVersion, `${todayPrefix()}.1`);
});

Deno.test("extensionVersion: same-day bump increments micro", async () => {
  const deps = makeDeps({
    getLatestVersion: () =>
      Promise.resolve({
        version: `${todayPrefix()}.3`,
        publishedAt: "2026-03-30T10:00:00Z",
      }),
  });
  const events = await collect<ExtensionVersionEvent>(
    extensionVersion(createLibSwampContext(), deps, {
      extensionName: "@myorg/my-ext",
    }),
  );

  const completed = events[1] as Extract<
    ExtensionVersionEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.currentPublished, `${todayPrefix()}.3`);
  assertEquals(completed.data.nextVersion, `${todayPrefix()}.4`);
});

Deno.test("extensionVersion: different-day bump resets micro to 1", async () => {
  const deps = makeDeps({
    getLatestVersion: () =>
      Promise.resolve({
        version: "2020.01.01.5",
        publishedAt: "2020-01-01T10:00:00Z",
      }),
  });
  const events = await collect<ExtensionVersionEvent>(
    extensionVersion(createLibSwampContext(), deps, {
      extensionName: "@myorg/old-ext",
    }),
  );

  const completed = events[1] as Extract<
    ExtensionVersionEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.currentPublished, "2020.01.01.5");
  assertEquals(completed.data.publishedAt, "2020-01-01T10:00:00Z");
  assertEquals(completed.data.nextVersion, `${todayPrefix()}.1`);
});

Deno.test("extensionVersion: registry error yields error event", async () => {
  const deps = makeDeps({
    getLatestVersion: () => Promise.reject(new Error("Network error")),
  });
  const events = await collect<ExtensionVersionEvent>(
    extensionVersion(createLibSwampContext(), deps, {
      extensionName: "@myorg/broken",
    }),
  );

  assertEquals(events.length, 2);
  const errorEvent = events[1] as Extract<
    ExtensionVersionEvent,
    { kind: "error" }
  >;
  assertEquals(errorEvent.kind, "error");
  assertEquals(errorEvent.error.code, "version_lookup_failed");
  assertStringIncludes(errorEvent.error.message, "Network error");
});
