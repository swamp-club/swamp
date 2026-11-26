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
import {
  type FederationAdminDeps,
  type FederationAdminEvent,
  memberView,
  runFederationAdmin,
} from "./federation_admin.ts";

export interface MemberListData {
  readonly members: ServeMemberRecord[];
}

export type MemberListEvent = FederationAdminEvent<MemberListData>;

export function memberList(
  _ctx: LibSwampContext,
  deps: FederationAdminDeps,
): AsyncGenerator<MemberListEvent> {
  return runFederationAdmin(
    "swamp.serve.member.list",
    "member_list_failed",
    async () => ({
      members: (await deps.admin.listMembers()).map(memberView),
    }),
  );
}
