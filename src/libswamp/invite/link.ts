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

/**
 * a read model owned by the server: get-or-create is idempotent, so the same
 * operative always gets the same code. No CLI-side invariant, so no domain
 * type.
 */
export interface InviteLinkData {
  code: string;
  url: string;
}

export type InviteLinkEvent =
  | { kind: "completed"; data: InviteLinkData }
  | { kind: "error"; error: SwampError };

// deno-lint-ignore no-empty-interface
export interface InviteLinkInput {}

export interface InviteLinkDeps {
  fetchRecruitLink: () => Promise<InviteLinkData>;
}

/**
 * knows nothing of the per-address invite path or its coming-soon substitution:
 * which link is printed is a CLI surface decision.
 */
export async function* inviteLink(
  ctx: LibSwampContext,
  deps: InviteLinkDeps,
  _input: InviteLinkInput,
): AsyncIterable<InviteLinkEvent> {
  yield* withGeneratorSpan(
    "swamp.invite.link",
    {},
    (async function* () {
      ctx.logger.debug`Fetching recruit link`;

      const result = await deps.fetchRecruitLink();

      yield {
        kind: "completed",
        data: result,
      };
    })(),
  );
}
