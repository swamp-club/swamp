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
import { validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface NamespaceUnsetData {
  previousNamespace: string;
}

export type NamespaceUnsetEvent =
  | { kind: "completed"; data: NamespaceUnsetData }
  | { kind: "error"; error: SwampError };

export interface NamespaceUnsetDeps {
  getCurrentNamespace: () => string | undefined;
  listNamespaces: () => Promise<string[]>;
  removeMarkerNamespace: () => Promise<void>;
}

export async function* datastoreNamespaceUnset(
  ctx: LibSwampContext,
  deps: NamespaceUnsetDeps,
): AsyncIterable<NamespaceUnsetEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.namespace.unset",
    {},
    (async function* () {
      const current = deps.getCurrentNamespace();
      if (!current) {
        yield {
          kind: "error",
          error: validationFailed(
            "No namespace is currently configured. Nothing to unset.",
          ),
        };
        return;
      }

      const namespaces = await deps.listNamespaces();
      if (namespaces.length > 1) {
        yield {
          kind: "error",
          error: validationFailed(
            `Cannot unset namespace: datastore contains ${namespaces.length} namespaces ` +
              `(${
                namespaces.join(", ")
              }). Unsetting is only allowed when a single namespace exists.`,
          ),
        };
        return;
      }

      await deps.removeMarkerNamespace();

      ctx.logger.info("Namespace unset (was {namespace})", {
        namespace: current,
      });

      yield {
        kind: "completed",
        data: { previousNamespace: current },
      };
    })(),
  );
}
