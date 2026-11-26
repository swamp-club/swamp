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
  DEFAULT_JOIN_TOKEN_DURATION_MS,
  type JoinTokenView,
  MAX_JOIN_TOKEN_DURATION_MS,
} from "../../domain/serve/join_token.ts";
import {
  type FederationAdminDeps,
  type FederationAdminEvent,
  runFederationAdmin,
} from "./federation_admin.ts";

export interface MemberTokenCreateInput {
  readonly name: string;
  readonly durationMs?: number;
}

export interface MemberTokenCreateData {
  readonly token: JoinTokenView;
  /** <name>.<secret>, shown once: the hub keeps only its hash */
  readonly joinToken: string;
}

export type MemberTokenCreateEvent = FederationAdminEvent<
  MemberTokenCreateData
>;

class MemberTokenDurationError extends Error {
  readonly code = "invalid_duration";
  constructor(message: string) {
    super(message);
    this.name = "MemberTokenDurationError";
  }
}

export function memberTokenCreate(
  _ctx: LibSwampContext,
  deps: FederationAdminDeps,
  input: MemberTokenCreateInput,
): AsyncGenerator<MemberTokenCreateEvent> {
  return runFederationAdmin(
    "swamp.serve.member.token.create",
    "member_token_create_failed",
    async () => {
      const durationMs = input.durationMs ?? DEFAULT_JOIN_TOKEN_DURATION_MS;
      if (
        !Number.isInteger(durationMs) || durationMs <= 0 ||
        durationMs > MAX_JOIN_TOKEN_DURATION_MS
      ) {
        throw new MemberTokenDurationError(
          "A join token lasts at least a millisecond and at most 30d",
        );
      }
      const { token, plaintext } = await deps.admin.createToken(
        input.name,
        durationMs,
      );
      return { token, joinToken: plaintext };
    },
  );
}
