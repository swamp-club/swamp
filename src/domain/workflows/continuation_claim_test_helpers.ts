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

import type {
  ContinuationClaim,
  ContinuationClaims,
  ContinuationClaimStore,
  HolderLiveness,
} from "./continuation_claim.ts";

/** A {@link ContinuationClaimStore} held in memory, for tests. */
export class InMemoryContinuationClaimStore implements ContinuationClaimStore {
  readonly claims: ContinuationClaim[] = [];

  find(
    runId: string,
    suspensionKey: string,
  ): Promise<ContinuationClaim | undefined> {
    const found = this.claims
      .filter((c) => c.runId === runId && c.suspensionKey === suspensionKey)
      .sort((a, b) => b.generation - a.generation);
    return Promise.resolve(found[0]);
  }

  create(claim: ContinuationClaim): Promise<boolean> {
    const taken = this.claims.some((c) =>
      c.runId === claim.runId && c.suspensionKey === claim.suspensionKey &&
      c.generation === claim.generation
    );
    if (!taken) this.claims.push({ ...claim });
    return Promise.resolve(!taken);
  }

  release(claim: ContinuationClaim): Promise<void> {
    const index = this.claims.findIndex((c) =>
      c.runId === claim.runId && c.suspensionKey === claim.suspensionKey &&
      c.generation === claim.generation
    );
    if (index >= 0) this.claims.splice(index, 1);
    return Promise.resolve();
  }

  removeForRun(runId: string): Promise<void> {
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (this.claims[i].runId === runId) this.claims.splice(i, 1);
    }
    return Promise.resolve();
  }
}

/**
 * Claims for `holder` over `store`. `liveness` says what is known of each
 * other holder; one it does not name is unknown.
 */
export function claimsFor(
  store: ContinuationClaimStore,
  holder: string,
  liveness: Record<string, HolderLiveness> = {},
): ContinuationClaims {
  return {
    store,
    holder,
    liveness: (other) => Promise.resolve(liveness[other] ?? "unknown"),
  };
}
