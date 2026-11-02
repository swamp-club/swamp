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

/**
 * a live rejection always blocks; a valid proof passes offline; without one
 * only a 5xx fails open, for 24 hours, since a client can provoke a 429, proxy
 * 403 or unreachable server and none may stand in for verification
 */

export type AuthMode = "verified" | "offline" | "none";

export type ProofSource = "signin_token" | "file";

export type LocalProofVerdict =
  | {
    readonly kind: "valid";
    readonly source: ProofSource;
    readonly issuedAt: number;
  }
  | { readonly kind: "missing" }
  | { readonly kind: "expired"; readonly issuedAt: number }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * valid means swamp-club signed its proof and the process that issued it is a
 * live ancestor running the same executable
 */
export type NestedPassVerdict =
  | { readonly kind: "valid" }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string };

export type IdentityCheckOutcome =
  | { readonly kind: "verified"; readonly freshProof: boolean }
  /** 401, `authenticated: false`, or a 403 carrying swamp-club's own error. */
  | { readonly kind: "rejected"; readonly status: number }
  | { readonly kind: "server_error"; readonly status: number }
  /** 429, or a 403 from a proxy, WAF or CDN in front of swamp-club. */
  | {
    readonly kind: "refused";
    readonly status: number;
    readonly retryAfterSeconds?: number;
  }
  | { readonly kind: "unreachable"; readonly reason: string };

export type BlockReason =
  | { readonly kind: "no_credential" }
  | { readonly kind: "revoked" }
  | {
    readonly kind: "refused";
    readonly status: number;
    readonly retryAfterSeconds?: number;
  }
  | {
    readonly kind: "unreachable_unverified";
    readonly daysSinceVerification?: number;
  }
  | { readonly kind: "unverified_for_a_day" };

export type StartupDecision =
  | { readonly kind: "pass"; readonly authMode: AuthMode }
  | { readonly kind: "block"; readonly reason: BlockReason }
  /**
   * Call swamp-club before deciding. `blocking` when there is no valid
   * proof; `short` when a valid signin-token proof is due its live check.
   */
  | { readonly kind: "check"; readonly timeout: "blocking" | "short" };

export type FinalDecision =
  | { readonly kind: "pass"; readonly authMode: AuthMode }
  | { readonly kind: "block"; readonly reason: BlockReason };

export interface GateEffects {
  readonly saveProof: boolean;
  readonly deleteFileProof: boolean;
  /** Start the 24-hour fail-open window (only if none is running). */
  readonly markFailOpen: boolean;
  readonly clearFailOpen: boolean;
  readonly recordTokenCheck: boolean;
  readonly clearTokenCheck: boolean;
}

export const NO_EFFECTS: GateEffects = {
  saveProof: false,
  deleteFileProof: false,
  markFailOpen: false,
  clearFailOpen: false,
  recordTokenCheck: false,
  clearTokenCheck: false,
};

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

export const TOKEN_CHECK_TTL_SECONDS = HOUR;
export const FAIL_OPEN_WINDOW_SECONDS = DAY;
export const REFRESH_AFTER_SECONDS = 7 * DAY;
export const REFRESH_RETRY_SECONDS = HOUR;

/**
 * a future or non-finite time, from a skewed clock or hand-edited file, counts
 * as absent so it can never widen a window
 */
function isPastTime(since: number | undefined, now: number): since is number {
  return since !== undefined && Number.isFinite(since) && since <= now;
}

export interface BeforeCheckInput {
  readonly credentialPresent: boolean;
  readonly proof: LocalProofVerdict;
  readonly lastTokenCheckAt?: number;
  /** Considered only without a credential: one always takes precedence. */
  readonly nestedPass?: NestedPassVerdict;
  readonly now: number;
}

export function decideBeforeCheck(input: BeforeCheckInput): StartupDecision {
  if (!input.credentialPresent) {
    // A nested run inherits its ancestor's pass, which rested on a signed
    // proof checked with no network call, so it reports the same mode.
    if (input.nestedPass?.kind === "valid") {
      return { kind: "pass", authMode: "verified" };
    }
    return { kind: "block", reason: { kind: "no_credential" } };
  }
  const { proof } = input;
  if (proof.kind !== "valid") {
    return { kind: "check", timeout: "blocking" };
  }
  if (proof.source === "file") {
    return { kind: "pass", authMode: "verified" };
  }
  const last = input.lastTokenCheckAt;
  if (
    isPastTime(last, input.now) &&
    input.now - last < TOKEN_CHECK_TTL_SECONDS
  ) {
    return { kind: "pass", authMode: "verified" };
  }
  return { kind: "check", timeout: "short" };
}

export interface AfterCheckInput {
  readonly proof: LocalProofVerdict;
  readonly outcome: IdentityCheckOutcome;
  readonly failOpenSince?: number;
  readonly now: number;
}

export interface AfterCheckResult {
  readonly decision: FinalDecision;
  readonly effects: GateEffects;
}

function daysSince(issuedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - issuedAt) / DAY));
}

export function decideAfterCheck(input: AfterCheckInput): AfterCheckResult {
  const { proof, outcome, now } = input;
  const hasValidProof = proof.kind === "valid";
  const fromToken = hasValidProof && proof.source === "signin_token";

  switch (outcome.kind) {
    case "verified":
      return {
        decision: { kind: "pass", authMode: "verified" },
        effects: {
          ...NO_EFFECTS,
          saveProof: outcome.freshProof,
          clearFailOpen: true,
          recordTokenCheck: fromToken,
        },
      };
    case "rejected":
      return {
        decision: { kind: "block", reason: { kind: "revoked" } },
        effects: {
          ...NO_EFFECTS,
          deleteFileProof: true,
          clearTokenCheck: true,
        },
      };
    default:
      break;
  }

  if (hasValidProof) {
    return {
      decision: { kind: "pass", authMode: "offline" },
      effects: NO_EFFECTS,
    };
  }

  switch (outcome.kind) {
    case "server_error": {
      const since = input.failOpenSince;
      if (!isPastTime(since, now)) {
        return {
          decision: { kind: "pass", authMode: "offline" },
          effects: { ...NO_EFFECTS, markFailOpen: true },
        };
      }
      if (now - since < FAIL_OPEN_WINDOW_SECONDS) {
        return {
          decision: { kind: "pass", authMode: "offline" },
          effects: NO_EFFECTS,
        };
      }
      return {
        decision: { kind: "block", reason: { kind: "unverified_for_a_day" } },
        effects: NO_EFFECTS,
      };
    }
    case "refused":
      return {
        decision: {
          kind: "block",
          reason: {
            kind: "refused",
            status: outcome.status,
            retryAfterSeconds: outcome.retryAfterSeconds,
          },
        },
        effects: NO_EFFECTS,
      };
    case "unreachable":
      return {
        decision: {
          kind: "block",
          reason: {
            kind: "unreachable_unverified",
            daysSinceVerification: proof.kind === "expired"
              ? daysSince(proof.issuedAt, now)
              : undefined,
          },
        },
        effects: NO_EFFECTS,
      };
  }
}

/**
 * the refresh runs at exit with a timeout, so the one-hour spacing keeps an
 * offline user from waiting at every exit
 */
export function shouldRefresh(
  proof: LocalProofVerdict,
  now: number,
  lastAttemptAt?: number,
): boolean {
  if (proof.kind !== "valid" || proof.source !== "file") return false;
  if (now - proof.issuedAt <= REFRESH_AFTER_SECONDS) return false;
  return !(isPastTime(lastAttemptAt, now) &&
    now - lastAttemptAt < REFRESH_RETRY_SECONDS);
}

/**
 * never changes the current run, which already passed: a rejection deletes the
 * proof so the next command blocks; any failure keeps it for the next attempt
 */
export function refreshEffects(outcome: IdentityCheckOutcome): GateEffects {
  switch (outcome.kind) {
    case "verified":
      return {
        ...NO_EFFECTS,
        saveProof: outcome.freshProof,
        clearFailOpen: true,
      };
    case "rejected":
      return { ...NO_EFFECTS, deleteFileProof: true };
    default:
      return NO_EFFECTS;
  }
}
