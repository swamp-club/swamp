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

import { assertCompletes } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  datastoreNamespaceList,
  type NamespaceListDeps,
  type NamespaceListEvent,
} from "./namespace_list.ts";

function makeDeps(
  overrides: Partial<NamespaceListDeps> = {},
): NamespaceListDeps {
  return {
    getCurrentNamespace: () => undefined,
    listNamespaces: () => Promise.resolve([]),
    ...overrides,
  };
}

Deno.test("datastoreNamespaceList: empty datastore returns empty list", async () => {
  const deps = makeDeps();
  await assertCompletes<NamespaceListEvent>(
    datastoreNamespaceList(createLibSwampContext(), deps),
    {
      kind: "completed",
      data: { namespaces: [], currentNamespace: undefined },
    },
  );
});

Deno.test("datastoreNamespaceList: lists namespaces with current marker", async () => {
  const deps = makeDeps({
    getCurrentNamespace: () => "infra",
    listNamespaces: () =>
      Promise.resolve([
        {
          namespace: "infra",
          repoId: "repo-1",
          registeredAt: "2026-01-01T00:00:00Z",
        },
        {
          namespace: "security",
          repoId: "repo-2",
          registeredAt: "2026-01-02T00:00:00Z",
        },
      ]),
  });

  await assertCompletes<NamespaceListEvent>(
    datastoreNamespaceList(createLibSwampContext(), deps),
    {
      kind: "completed",
      data: {
        namespaces: [
          {
            namespace: "infra",
            repoId: "repo-1",
            registeredAt: "2026-01-01T00:00:00Z",
            isCurrent: true,
          },
          {
            namespace: "security",
            repoId: "repo-2",
            registeredAt: "2026-01-02T00:00:00Z",
            isCurrent: false,
          },
        ],
        currentNamespace: "infra",
      },
    },
  );
});

Deno.test("datastoreNamespaceList: no current namespace marks none as current", async () => {
  const deps = makeDeps({
    listNamespaces: () =>
      Promise.resolve([
        {
          namespace: "infra",
          repoId: "repo-1",
          registeredAt: "2026-01-01T00:00:00Z",
        },
      ]),
  });

  await assertCompletes<NamespaceListEvent>(
    datastoreNamespaceList(createLibSwampContext(), deps),
    {
      kind: "completed",
      data: {
        namespaces: [
          {
            namespace: "infra",
            repoId: "repo-1",
            registeredAt: "2026-01-01T00:00:00Z",
            isCurrent: false,
          },
        ],
        currentNamespace: undefined,
      },
    },
  );
});
