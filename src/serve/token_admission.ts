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

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type AdmissionLists,
  type AdmissionResult,
  checkPrincipalAdmission,
} from "../domain/access/admission.ts";
import type { ServerToken } from "../domain/models/access/server_token_model.ts";
import type { LinkedPerson } from "../domain/models/access/delegation_model.ts";

const logger = getSwampLogger(["serve", "token-admission"]);

const OUTSIDE_ADMISSION: AdmissionResult = {
  admitted: true,
  reason: "credential was not issued by a login",
};

/** Admission of credentials already issued, read against the lists in force. */
export interface TokenAdmissionChecker {
  serverToken(
    token:
      & Pick<
        ServerToken,
        "name" | "principalId" | "collectives" | "createdAt" | "vaultName"
      >
      & { readonly oauthIdentity?: unknown },
  ): Promise<AdmissionResult>;
  delegation(
    person: {
      readonly sub: LinkedPerson["sub"];
      readonly collectives: readonly string[];
    },
  ): AdmissionResult;
}

export interface TokenAdmissionDeps {
  /** read on every check, so a change to the lists applies at once */
  readonly lists: () => AdmissionLists;
  /**
   * whether an OAuth login stored an access token for this token; throws when
   * it cannot tell
   */
  readonly hasStoredLogin: (
    token: { readonly name: string; readonly vaultName: string },
  ) => Promise<boolean>;
}

export function createTokenAdmissionChecker(
  deps: TokenAdmissionDeps,
): TokenAdmissionChecker {
  // keyed by mint: rotation changes createdAt, and a mint's origin never changes
  const loginIssued = new Map<string, boolean>();

  async function isLoginIssued(
    token: Parameters<TokenAdmissionChecker["serverToken"]>[0],
  ): Promise<boolean> {
    if (token.oauthIdentity !== undefined) return true;
    if (!token.principalId.startsWith("user:")) return false;
    const key = `${token.name}\u0000${token.createdAt}`;
    const known = loginIssued.get(key);
    if (known !== undefined) return known;
    try {
      const stored = await deps.hasStoredLogin(token);
      loginIssued.set(key, stored);
      return stored;
    } catch (error) {
      // not cached: an outage must not exempt the token for good
      logger
        .warn`Could not tell whether token ${token.name} came from a login; treating it as outside admission: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return false;
    }
  }

  return {
    async serverToken(token) {
      if (!await isLoginIssued(token)) return OUTSIDE_ADMISSION;
      return checkPrincipalAdmission(
        token.principalId,
        token.collectives,
        deps.lists(),
      );
    },
    delegation(person) {
      return checkPrincipalAdmission(
        `user:${person.sub}`,
        person.collectives,
        deps.lists(),
      );
    },
  };
}
