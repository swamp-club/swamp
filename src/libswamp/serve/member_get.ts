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
import type { ServeMemberRecord } from "../../domain/serve/serve_member.ts";
import type { ServeMemberLiveRecord } from "../../domain/serve/member_live_view.ts";
import {
  type FederationAdminDeps,
  type FederationAdminEvent,
  memberLiveRecord,
  runFederationAdmin,
} from "./federation_admin.ts";

export interface MemberGetInput {
  readonly name: string;
}

export interface MemberData {
  readonly member: ServeMemberRecord;
}

export interface MemberGetData {
  readonly member: ServeMemberLiveRecord;
  /** the hub's time when it answered */
  readonly now: string;
}

export type MemberGetEvent = FederationAdminEvent<MemberGetData>;

class MemberNotFoundError extends Error {
  readonly code = "not_found";
}

export function memberGet(
  _ctx: LibSwampContext,
  deps: FederationAdminDeps,
  input: MemberGetInput,
): AsyncGenerator<MemberGetEvent> {
  return runFederationAdmin(
    "swamp.serve.member.get",
    "member_get_failed",
    async () => {
      const member = await deps.admin.getMember(input.name);
      if (member === null) {
        throw new MemberNotFoundError(`No member named '${input.name}'`);
      }
      const sightings = await deps.admin.sightings(member.memberId);
      return {
        member: memberLiveRecord(member, sightings),
        now: new Date(deps.admin.now()).toISOString(),
      };
    },
  );
}
