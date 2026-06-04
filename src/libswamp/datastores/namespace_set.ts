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
import { createNamespace } from "../../domain/data/namespace.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface NamespaceSetData {
  namespace: string;
  datastorePath: string;
  warning: string;
  registrationSkipped?: boolean;
}

export type NamespaceSetEvent =
  | { kind: "completed"; data: NamespaceSetData }
  | { kind: "error"; error: SwampError };

export interface NamespaceSetInput {
  slug: string;
}

export interface NamespaceRegistration {
  namespace: string;
  repoId: string;
}

export interface NamespaceSetDeps {
  getDatastorePath: () => string;
  getCurrentNamespace: () => string | undefined;
  listNamespaces: () => Promise<NamespaceRegistration[]>;
  registerNamespace: (namespace: string, repoId: string) => Promise<void>;
  updateMarkerNamespace: (namespace: string) => Promise<void>;
  getRepoId: () => string;
  supportsRegistration: boolean;
}

export async function* datastoreNamespaceSet(
  ctx: LibSwampContext,
  deps: NamespaceSetDeps,
  input: NamespaceSetInput,
): AsyncIterable<NamespaceSetEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.namespace.set",
    { "namespace.slug": input.slug },
    (async function* () {
      let ns;
      try {
        ns = createNamespace(input.slug);
      } catch (error) {
        yield {
          kind: "error",
          error: validationFailed(
            error instanceof Error ? error.message : String(error),
          ),
        };
        return;
      }

      const slug: string = ns as string;
      const current = deps.getCurrentNamespace();
      if (current === slug) {
        yield {
          kind: "error",
          error: validationFailed(
            `Namespace is already set to "${slug}".`,
          ),
        };
        return;
      }

      if (current) {
        ctx.logger.info(
          "Changing namespace from {old} to {new}",
          { old: current, new: slug },
        );
      }

      const datastorePath = deps.getDatastorePath();
      const repoId = deps.getRepoId();
      let registrationSkipped = false;

      if (deps.supportsRegistration) {
        const existing = await deps.listNamespaces();
        const conflict = existing.find((r) => r.namespace === slug);
        if (conflict && conflict.repoId !== repoId) {
          yield {
            kind: "error",
            error: validationFailed(
              `Namespace "${slug}" is already registered in this datastore by repo ${conflict.repoId}.`,
            ),
          };
          return;
        }
      } else {
        registrationSkipped = true;
        ctx.logger.warn(
          "Datastore backend does not support namespace registration — conflict detection is unavailable",
        );
      }

      await deps.updateMarkerNamespace(slug);

      if (deps.supportsRegistration) {
        await deps.registerNamespace(slug, repoId);
      }

      ctx.logger.info("Namespace set to {namespace}", { namespace: slug });

      let warning = "Existing data remains at the old un-namespaced path. " +
        "Run 'swamp datastore namespace migrate --confirm' to move it to the namespaced layout.";
      if (registrationSkipped) {
        warning +=
          "\n\nThis datastore backend does not support namespace registration. " +
          `Conflict detection is unavailable — ensure no other repo uses the namespace "${slug}" in this datastore.`;
      }

      yield {
        kind: "completed",
        data: {
          namespace: slug,
          datastorePath,
          warning,
          registrationSkipped,
        },
      };
    })(),
  );
}
