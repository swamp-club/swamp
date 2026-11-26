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
import {
  type FederationAdminDeps,
  type FederationAdminEvent,
  memberView,
  runFederationAdmin,
} from "./federation_admin.ts";
import type { MemberData } from "./member_get.ts";

export interface MemberRemoveInput {
  readonly name: string;
}

export type MemberRemoveEvent = FederationAdminEvent<MemberData>;

/** the record is kept, marked removed, and the member's credential stops working */
export function memberRemove(
  _ctx: LibSwampContext,
  deps: FederationAdminDeps,
  input: MemberRemoveInput,
): AsyncGenerator<MemberRemoveEvent> {
  return runFederationAdmin(
    "swamp.serve.member.remove",
    "member_remove_failed",
    async () => ({
      member: memberView(await deps.admin.removeMember(input.name)),
    }),
  );
}
