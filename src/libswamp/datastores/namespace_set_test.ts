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
  datastoreNamespaceSet,
  type NamespaceSetDeps,
  type NamespaceSetEvent,
} from "./namespace_set.ts";

function makeDeps(
  overrides: Partial<NamespaceSetDeps> = {},
): NamespaceSetDeps {
  return {
    getDatastorePath: () => "/tmp/ds",
    getCurrentNamespace: () => undefined,
    listNamespaces: () => Promise.resolve([]),
    registerNamespace: () => Promise.resolve(),
    updateMarkerNamespace: () => Promise.resolve(),
    getRepoId: () => "repo-1",
    supportsRegistration: true,
    ...overrides,
  };
}

Deno.test("datastoreNamespaceSet: valid slug succeeds", async () => {
  let registered = "";
  let markerUpdated = "";
  const deps = makeDeps({
    registerNamespace: (ns) => {
      registered = ns;
      return Promise.resolve();
    },
    updateMarkerNamespace: (ns) => {
      markerUpdated = ns;
      return Promise.resolve();
    },
  });

  const completed = await assertCompletes<NamespaceSetEvent>(
    datastoreNamespaceSet(createLibSwampContext(), deps, { slug: "infra" }),
    {
      kind: "completed",
      data: {
        namespace: "infra",
        datastorePath: "/tmp/ds",
        warning: "Existing data remains at the old un-namespaced path. " +
          "Run 'swamp datastore namespace migrate --confirm' to move it to the namespaced layout.",
        registrationSkipped: false,
      },
    },
  );
  assertEquals(completed.kind, "completed");
  assertEquals(registered, "infra");
  assertEquals(markerUpdated, "infra");
});

Deno.test("datastoreNamespaceSet: invalid slug yields error", async () => {
  const deps = makeDeps();
  await assertErrors<NamespaceSetEvent>(
    datastoreNamespaceSet(createLibSwampContext(), deps, { slug: "INVALID" }),
    "validation_failed",
  );
});

Deno.test("datastoreNamespaceSet: already-set namespace yields error", async () => {
  const deps = makeDeps({
    getCurrentNamespace: () => "infra",
  });
  const error = await assertErrors<NamespaceSetEvent>(
    datastoreNamespaceSet(createLibSwampContext(), deps, { slug: "infra" }),
    "validation_failed",
  );
  assertEquals(error.message, 'Namespace is already set to "infra".');
});

Deno.test("datastoreNamespaceSet: conflict with different repoId yields error", async () => {
  const deps = makeDeps({
    listNamespaces: () =>
      Promise.resolve([{ namespace: "infra", repoId: "other-repo" }]),
  });
  const error = await assertErrors<NamespaceSetEvent>(
    datastoreNamespaceSet(createLibSwampContext(), deps, { slug: "infra" }),
    "validation_failed",
  );
  assertEquals(
    error.message,
    'Namespace "infra" is already registered in this datastore by repo other-repo.',
  );
});

Deno.test("datastoreNamespaceSet: re-registration with same repoId succeeds", async () => {
  const deps = makeDeps({
    listNamespaces: () =>
      Promise.resolve([{ namespace: "infra", repoId: "repo-1" }]),
  });
  const events = await collect<NamespaceSetEvent>(
    datastoreNamespaceSet(createLibSwampContext(), deps, { slug: "infra" }),
  );
  const last = events[events.length - 1];
  assertEquals(last.kind, "completed");
});

Deno.test("datastoreNamespaceSet: registration skipped when unsupported", async () => {
  let registerCalled = false;
  const deps = makeDeps({
    supportsRegistration: false,
    registerNamespace: () => {
      registerCalled = true;
      return Promise.resolve();
    },
  });

  const events = await collect<NamespaceSetEvent>(
    datastoreNamespaceSet(createLibSwampContext(), deps, { slug: "infra" }),
  );
  const last = events[events.length - 1] as Extract<
    NamespaceSetEvent,
    { kind: "completed" }
  >;
  assertEquals(last.kind, "completed");
  assertEquals(last.data.registrationSkipped, true);
  assertEquals(registerCalled, false);
});

Deno.test("datastoreNamespaceSet: marker updated before registration", async () => {
  const callOrder: string[] = [];
  const deps = makeDeps({
    updateMarkerNamespace: () => {
      callOrder.push("marker");
      return Promise.resolve();
    },
    registerNamespace: () => {
      callOrder.push("register");
      return Promise.resolve();
    },
  });

  await collect<NamespaceSetEvent>(
    datastoreNamespaceSet(createLibSwampContext(), deps, { slug: "infra" }),
  );
  assertEquals(callOrder, ["marker", "register"]);
});
