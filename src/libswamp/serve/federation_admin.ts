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

import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { JoinTokenView } from "../../domain/serve/join_token.ts";
import type {
  ServeMember,
  ServeMemberRecord,
} from "../../domain/serve/serve_member.ts";

/** what a federation hub offers its operators; serve's FederationHub is one */
export interface FederationAdmin {
  createToken(
    name: string,
    durationMs?: number,
  ): Promise<{ readonly token: JoinTokenView; readonly plaintext: string }>;
  listTokens(): Promise<JoinTokenView[]>;
  revokeToken(name: string): Promise<JoinTokenView>;
  listMembers(): Promise<ServeMember[]>;
  getMember(name: string): Promise<ServeMember | null>;
  removeMember(name: string): Promise<ServeMember>;
}

export interface FederationAdminDeps {
  readonly admin: FederationAdmin;
}

export type FederationAdminEvent<T> =
  | { kind: "resolving" }
  | { kind: "completed"; data: T }
  | { kind: "error"; error: SwampError };

const HUB_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_name",
  "hub_name",
  "invalid_duration",
  "not_found",
  "token_not_unused",
]);

/** a hub refusal keeps its code, so a caller can tell a missing member from a failure */
export function federationAdminError(
  error: unknown,
  fallbackCode: string,
): SwampError {
  const code = typeof error === "object" && error !== null &&
      "code" in error && typeof error.code === "string" &&
      HUB_ERROR_CODES.has(error.code)
    ? error.code
    : fallbackCode;
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function memberView(member: ServeMember): ServeMemberRecord {
  return member.toJSON();
}

export async function* runFederationAdmin<T>(
  spanName: string,
  fallbackCode: string,
  call: () => Promise<T>,
): AsyncGenerator<FederationAdminEvent<T>> {
  yield* withGeneratorSpan(
    spanName,
    {},
    (async function* (): AsyncGenerator<FederationAdminEvent<T>> {
      yield { kind: "resolving" };
      try {
        yield { kind: "completed", data: await call() };
      } catch (error) {
        yield {
          kind: "error",
          error: federationAdminError(error, fallbackCode),
        };
      }
    })(),
  );
}
