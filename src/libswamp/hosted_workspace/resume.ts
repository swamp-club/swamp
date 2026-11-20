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

import type { HostedWorkspaceWanted } from "../../domain/serve/hosted_workspace.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import {
  adminOnlyRefusal,
  changeHostedWorkspace,
  type HostedWorkspaceDeps,
  hostedWorkspaceErrorEvent,
  nameClashUnstartable,
} from "./deps.ts";

export interface HostedWorkspaceResumeData {
  readonly name: string;
  readonly wanted: HostedWorkspaceWanted;
  readonly changedAt: string | null;
}

export type HostedWorkspaceResumeEvent =
  | { kind: "completed"; data: HostedWorkspaceResumeData }
  | { kind: "error"; error: SwampError };

/** the host starts it again; a changed active record also takes it out of failed */
export async function* hostedWorkspaceResume(
  ctx: LibSwampContext,
  deps: HostedWorkspaceDeps,
  /** rootAdmin: the caller is one of the root's admins, as the request handler decided */
  input: { name: string; rootAdmin?: boolean },
): AsyncIterable<HostedWorkspaceResumeEvent> {
  yield* withGeneratorSpan(
    "swamp.hosted_workspace.resume",
    {},
    (async function* () {
      try {
        const workspace = await changeHostedWorkspace(ctx, deps, input.name, {
          apply: (current, at) => current.resume(at),
          refuse: (name, whose) =>
            whose.shadows
              ? nameClashUnstartable(name)
              : adminOnlyRefusal(name, whose, input.rootAdmin),
        });
        yield {
          kind: "completed" as const,
          data: {
            name: workspace.name,
            wanted: workspace.wanted,
            changedAt: workspace.changedAt,
          },
        };
      } catch (error) {
        yield hostedWorkspaceErrorEvent(ctx, error);
      }
    })(),
  );
}
