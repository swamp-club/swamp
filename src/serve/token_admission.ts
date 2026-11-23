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

export interface TokenAdmissionResult extends AdmissionResult {
  /** serve could not tell whether a login issued the credential, so it refuses */
  readonly unavailable?: true;
}

const OUTSIDE_ADMISSION: TokenAdmissionResult = {
  admitted: true,
  reason: "credential was not issued by a login",
};

const UNAVAILABLE: TokenAdmissionResult = {
  admitted: false,
  unavailable: true,
  reason: "could not tell whether the credential was issued by a login",
};

export interface TokenAdmissionChecker {
  serverToken(
    token:
      & Pick<
        ServerToken,
        "name" | "principalId" | "collectives" | "createdAt" | "vaultName"
      >
      & { readonly oauthIdentity?: unknown },
  ): Promise<TokenAdmissionResult>;
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

  /** undefined when the lookup could not answer */
  async function isLoginIssued(
    token: Parameters<TokenAdmissionChecker["serverToken"]>[0],
  ): Promise<boolean | undefined> {
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
      // fails closed, and not cached, so the token works again once the lookup does
      logger
        .warn`Could not tell whether token ${token.name} came from a login; refusing it until serve can: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return undefined;
    }
  }

  return {
    async serverToken(token) {
      const issued = await isLoginIssued(token);
      if (issued === undefined) return UNAVAILABLE;
      if (!issued) return OUTSIDE_ADMISSION;
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

/** Shares one pending result; a rejection is dropped so the next call retries. */
export function cachedUnlessRejected<T>(
  factory: () => Promise<T>,
): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (pending === undefined) {
      const attempt = factory();
      pending = attempt;
      attempt.catch(() => {
        if (pending === attempt) pending = undefined;
      });
    }
    return pending;
  };
}
