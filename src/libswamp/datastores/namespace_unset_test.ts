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
  datastoreNamespaceUnset,
  type NamespaceUnsetDeps,
  type NamespaceUnsetEvent,
} from "./namespace_unset.ts";

function makeDeps(
  overrides: Partial<NamespaceUnsetDeps> = {},
): NamespaceUnsetDeps {
  return {
    getCurrentNamespace: () => "infra",
    listNamespaces: () => Promise.resolve(["infra"]),
    removeMarkerNamespace: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("datastoreNamespaceUnset: unset with single namespace succeeds", async () => {
  let removed = false;
  const deps = makeDeps({
    removeMarkerNamespace: () => {
      removed = true;
      return Promise.resolve();
    },
  });

  await assertCompletes<NamespaceUnsetEvent>(
    datastoreNamespaceUnset(createLibSwampContext(), deps),
    {
      kind: "completed",
      data: { previousNamespace: "infra" },
    },
  );
  assertEquals(removed, true);
});

Deno.test("datastoreNamespaceUnset: no namespace configured yields error", async () => {
  const deps = makeDeps({
    getCurrentNamespace: () => undefined,
  });
  const error = await assertErrors<NamespaceUnsetEvent>(
    datastoreNamespaceUnset(createLibSwampContext(), deps),
    "validation_failed",
  );
  assertEquals(
    error.message,
    "No namespace is currently configured. Nothing to unset.",
  );
});

Deno.test("datastoreNamespaceUnset: blocked with multiple namespaces", async () => {
  const deps = makeDeps({
    listNamespaces: () => Promise.resolve(["infra", "security"]),
  });
  const error = await assertErrors<NamespaceUnsetEvent>(
    datastoreNamespaceUnset(createLibSwampContext(), deps),
    "validation_failed",
  );
  assertEquals(
    error.message,
    "Cannot unset namespace: datastore contains 2 namespaces " +
      "(infra, security). Unsetting is only allowed when a single namespace exists.",
  );
});
