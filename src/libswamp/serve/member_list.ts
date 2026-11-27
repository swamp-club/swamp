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
import type { ServeMemberLiveRecord } from "../../domain/serve/member_live_view.ts";
import {
  type FederationAdminDeps,
  type FederationAdminEvent,
  memberLiveRecord,
  runFederationAdmin,
} from "./federation_admin.ts";

export interface MemberListData {
  readonly members: ServeMemberLiveRecord[];
  /** the hub's time when it answered */
  readonly now: string;
}

export type MemberListEvent = FederationAdminEvent<MemberListData>;

export function memberList(
  _ctx: LibSwampContext,
  deps: FederationAdminDeps,
): AsyncGenerator<MemberListEvent> {
  return runFederationAdmin(
    "swamp.serve.member.list",
    "member_list_failed",
    async () => {
      const members = await deps.admin.listMembers();
      const sightings = await deps.admin.sightings();
      return {
        members: members.map((member) => memberLiveRecord(member, sightings)),
        now: new Date(deps.admin.now()).toISOString(),
      };
    },
  );
}
