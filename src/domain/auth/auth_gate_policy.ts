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
 * The auth gate's decisions, as pure functions over what the CLI knows at
 * startup: whether a credential exists, whether a signed proof for it
 * verifies locally, and — when the gate asked — what swamp-club said.
 *
 * The rules (design/surfaces/auth-gate.md):
 *   - No credential always blocks.
 *   - A valid proof passes with no network call. A signin-token proof (CI)
 *     is checked live at most once an hour, because a revoked key cannot
 *     delete the environment variable that carries it.
 *   - A live rejection always blocks, proof or not.
 *   - With a valid proof, any other failure passes as `offline`.
 *   - Without one, only a 5xx from swamp-club fails open, and only for 24
 *     hours from the first one recorded. A 429, a 403 from something in
 *     front of swamp-club, or an unreachable server blocks: a client can
 *     provoke all three, so none of them may stand in for verification.
 *
 * All times are Unix seconds, matching the proof's `iat` and `exp`.
 */

/** How a run was authenticated, as reported in telemetry. */
export type AuthMode = "verified" | "offline" | "none";

/** Where a proof came from: `SWAMP_SIGNIN_TOKEN` or `auth_verified.json`. */
export type ProofSource = "signin_token" | "file";

/** What local verification made of the best proof for the active key. */
export type LocalProofVerdict =
  | {
    readonly kind: "valid";
    readonly source: ProofSource;
    readonly issuedAt: number;
  }
  | { readonly kind: "missing" }
  | { readonly kind: "expired"; readonly issuedAt: number }
  | { readonly kind: "invalid"; readonly reason: string };

/** What a live `/api/whoami` call said, classified by who said it. */
export type IdentityCheckOutcome =
  /** 200 with `authenticated: true`. */
  | { readonly kind: "verified"; readonly freshProof: boolean }
  /** 401, `authenticated: false`, or a 403 carrying swamp-club's own error. */
  | { readonly kind: "rejected"; readonly status: number }
  /** swamp-club answered with a 5xx. */
  | { readonly kind: "server_error"; readonly status: number }
  /** 429, or a 403 from a proxy, WAF or CDN in front of swamp-club. */
  | {
    readonly kind: "refused";
    readonly status: number;
    readonly retryAfterSeconds?: number;
  }
  /** No HTTP response: timeout, DNS or connection failure. */
  | { readonly kind: "unreachable"; readonly reason: string };

export type BlockReason =
  | { readonly kind: "no_credential" }
  | { readonly kind: "revoked" }
  | {
    readonly kind: "refused";
    /** The HTTP status that was not swamp-club's answer. */
    readonly status: number;
    readonly retryAfterSeconds?: number;
  }
  | {
    readonly kind: "unreachable_unverified";
    /** Days since the last proof was issued, when an expired one exists. */
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

/** State changes the gate makes after a live check. */
export interface GateEffects {
  /** Cache the proof that came back with a verified response. */
  readonly saveProof: boolean;
  /** Remove `auth_verified.json`: swamp-club rejected the key. */
  readonly deleteFileProof: boolean;
  /** Start the 24-hour fail-open window (only if none is running). */
  readonly markFailOpen: boolean;
  /** End the fail-open window: swamp-club verified the key. */
  readonly clearFailOpen: boolean;
  /** Remember that the signin token verified live, to skip the next hour. */
  readonly recordTokenCheck: boolean;
  /** Forget a remembered signin-token check. */
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

/** How long a verified signin-token check is reused. */
export const TOKEN_CHECK_TTL_SECONDS = HOUR;
/** How long a server error may stand in for verification without a proof. */
export const FAIL_OPEN_WINDOW_SECONDS = DAY;
/** Age at which a file proof is refreshed in the background. */
export const REFRESH_AFTER_SECONDS = 7 * DAY;
/** How long a failed refresh waits before the next attempt. */
export const REFRESH_RETRY_SECONDS = HOUR;

/**
 * True when `since` is a usable past time. A future or non-finite time —
 * a skewed clock or a hand-edited file — counts as absent, so it can never
 * widen a window.
 */
function isPastTime(since: number | undefined, now: number): since is number {
  return since !== undefined && Number.isFinite(since) && since <= now;
}

export interface BeforeCheckInput {
  readonly credentialPresent: boolean;
  readonly proof: LocalProofVerdict;
  /** When the signin token last verified live, if remembered. */
  readonly lastTokenCheckAt?: number;
  readonly now: number;
}

/** Decide what the gate can settle without talking to swamp-club. */
export function decideBeforeCheck(input: BeforeCheckInput): StartupDecision {
  if (!input.credentialPresent) {
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
  /** When the current fail-open window started, if one is running. */
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

/** Decide a run once swamp-club has answered (or failed to). */
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
 * True when a file proof is old enough for the weekly background refresh and
 * no attempt was made in the last hour. The refresh runs at exit with a
 * timeout, so without the hour an offline user would wait at every exit.
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
 * What the weekly refresh does with swamp-club's answer. It never changes
 * the current run, which already passed: a rejection deletes the proof so
 * the next command blocks; any failure keeps it for the next attempt.
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
