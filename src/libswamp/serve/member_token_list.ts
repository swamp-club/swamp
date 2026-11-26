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
import type { JoinTokenView } from "../../domain/serve/join_token.ts";
import {
  type FederationAdminDeps,
  type FederationAdminEvent,
  runFederationAdmin,
} from "./federation_admin.ts";

export interface MemberTokenListData {
  readonly tokens: JoinTokenView[];
}

export type MemberTokenListEvent = FederationAdminEvent<MemberTokenListData>;

export function memberTokenList(
  _ctx: LibSwampContext,
  deps: FederationAdminDeps,
): AsyncGenerator<MemberTokenListEvent> {
  return runFederationAdmin(
    "swamp.serve.member.token.list",
    "member_token_list_failed",
    async () => ({ tokens: await deps.admin.listTokens() }),
  );
}
