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
    getPublishedVersions: () => Promise.resolve(null),
    ...overrides,
  };
}

function completedData(events: ExtensionVersionEvent[]) {
  const completed = events[1] as Extract<
    ExtensionVersionEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  return completed.data;
}

function todayPrefix(): string {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}`;
}

Deno.test("extensionVersion: never-published extension returns null published, no channels, and today.1", async () => {
  const deps = makeDeps();
  const events = await collect<ExtensionVersionEvent>(
    extensionVersion(createLibSwampContext(), deps, {
      extensionName: "@myorg/new-ext",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });

  const data = completedData(events);
  assertEquals(data.extensionName, "@myorg/new-ext");
  assertEquals(data.currentPublished, null);
  assertEquals(data.publishedAt, null);
  assertEquals(data.nextVersion, `${todayPrefix()}.1`);
  assertEquals(data.channels, undefined);
});

Deno.test("extensionVersion: same-day bump increments micro, no channels for stable-only", async () => {
  const deps = makeDeps({
    getPublishedVersions: () =>
      Promise.resolve({
        stable: `${todayPrefix()}.3`,
        beta: null,
        rc: null,
      }),
  });
  const events = await collect<ExtensionVersionEvent>(
    extensionVersion(createLibSwampContext(), deps, {
      extensionName: "@myorg/my-ext",
    }),
  );

  const data = completedData(events);
  assertEquals(data.currentPublished, `${todayPrefix()}.3`);
  assertEquals(data.nextVersion, `${todayPrefix()}.4`);
  assertEquals(data.channels, undefined);
});

Deno.test("extensionVersion: different-day bump resets micro to 1", async () => {
  const deps = makeDeps({
    getPublishedVersions: () =>
      Promise.resolve({ stable: "2020.01.01.5", beta: null, rc: null }),
  });
  const events = await collect<ExtensionVersionEvent>(
    extensionVersion(createLibSwampContext(), deps, {
      extensionName: "@myorg/old-ext",
    }),
  );

  const data = completedData(events);
  assertEquals(data.currentPublished, "2020.01.01.5");
  assertEquals(data.publishedAt, null);
  assertEquals(data.nextVersion, `${todayPrefix()}.1`);
  assertEquals(data.channels, undefined);
});

Deno.test("extensionVersion: prerelease-only extension computes next from today without throwing", async () => {
  const deps = makeDeps({
    getPublishedVersions: () =>
      Promise.resolve({ stable: null, beta: "2020.01.01.3", rc: null }),
  });
  const events = await collect<ExtensionVersionEvent>(
    extensionVersion(createLibSwampContext(), deps, {
      extensionName: "@shrug/mercury",
    }),
  );

  const data = completedData(events);
  assertEquals(data.currentPublished, null);
  assertEquals(data.nextVersion, `${todayPrefix()}.1`);
  assertEquals(data.channels, { beta: { latest: "2020.01.01.3" } });
});

Deno.test("extensionVersion: bumps past a prerelease published today to avoid collision", async () => {
  const deps = makeDeps({
    getPublishedVersions: () =>
      Promise.resolve({ stable: null, beta: `${todayPrefix()}.3`, rc: null }),
  });
  const events = await collect<ExtensionVersionEvent>(
    extensionVersion(createLibSwampContext(), deps, {
      extensionName: "@shrug/mercury",
    }),
  );

  const data = completedData(events);
  assertEquals(data.currentPublished, null);
  assertEquals(data.nextVersion, `${todayPrefix()}.4`);
  assertEquals(data.channels, { beta: { latest: `${todayPrefix()}.3` } });
});

Deno.test("extensionVersion: baseline is the highest version across all channels", async () => {
  // stable is older; rc is the newest published version.
  const deps = makeDeps({
    getPublishedVersions: () =>
      Promise.resolve({
        stable: "2020.01.01.1",
        beta: "2020.02.01.1",
        rc: `${todayPrefix()}.9`,
      }),
  });
  const events = await collect<ExtensionVersionEvent>(
    extensionVersion(createLibSwampContext(), deps, {
      extensionName: "@shrug/mercury",
    }),
  );

  const data = completedData(events);
  assertEquals(data.currentPublished, "2020.01.01.1");
  assertEquals(data.nextVersion, `${todayPrefix()}.10`);
  assertEquals(data.channels, {
    beta: { latest: "2020.02.01.1" },
    rc: { latest: `${todayPrefix()}.9` },
  });
});

Deno.test("extensionVersion: registry error yields error event", async () => {
  const deps = makeDeps({
    getPublishedVersions: () => Promise.reject(new Error("Network error")),
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
