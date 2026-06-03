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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface NamespaceInfo {
  namespace: string;
  repoId: string;
  registeredAt: string;
  isCurrent: boolean;
}

export interface NamespaceListData {
  namespaces: NamespaceInfo[];
  currentNamespace: string | undefined;
}

export type NamespaceListEvent =
  | { kind: "completed"; data: NamespaceListData }
  | { kind: "error"; error: SwampError };

export interface NamespaceListDeps {
  getCurrentNamespace: () => string | undefined;
  listNamespaces: () => Promise<
    Array<{ namespace: string; repoId: string; registeredAt: string }>
  >;
}

export async function* datastoreNamespaceList(
  _ctx: LibSwampContext,
  deps: NamespaceListDeps,
): AsyncIterable<NamespaceListEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.namespace.list",
    {},
    (async function* () {
      const current = deps.getCurrentNamespace();
      const manifests = await deps.listNamespaces();

      const namespaces: NamespaceInfo[] = manifests.map((m) => ({
        namespace: m.namespace,
        repoId: m.repoId,
        registeredAt: m.registeredAt,
        isCurrent: m.namespace === current,
      }));

      yield {
        kind: "completed",
        data: { namespaces, currentNamespace: current },
      };
    })(),
  );
}
