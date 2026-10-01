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

import { UserError } from "../domain/errors.ts";
import {
  type AuthMode,
  type BlockReason,
  decideAfterCheck,
  decideBeforeCheck,
  type GateEffects,
  type LocalProofVerdict,
  refreshEffects,
  shouldRefresh,
} from "../domain/auth/auth_gate_policy.ts";
import { verifyProof } from "../domain/auth/proof_verifier.ts";
import {
  computeProofFingerprint,
  parseProofPayload,
} from "../domain/auth/verification_proof.ts";
import {
  type IdentityCheckResult,
  SwampClubClient,
  type WhoamiResponse,
} from "../infrastructure/http/swamp_club_client.ts";
import { AuthRepository } from "../infrastructure/persistence/auth_repository.ts";
import {
  AuthVerificationRepository,
  type ProofCandidate,
} from "../infrastructure/persistence/auth_verification_repository.ts";
import { loadIdentity } from "./load_identity.ts";

/** How long the gate waits for swamp-club when there is no valid proof. */
export const BLOCKING_CHECK_TIMEOUT_MS = 10_000;
/** How long it waits for a signin-token check or the weekly refresh. */
export const SHORT_CHECK_TIMEOUT_MS = 3_000;

export interface AuthGateCredential {
  readonly apiKey: string;
  readonly serverUrl: string;
}

export interface AuthGateDeps {
  /** The active credential, honouring the usual key-source precedence. */
  loadCredential(): Promise<AuthGateCredential | null>;
  readonly verificationRepo: AuthVerificationRepository;
  verifyIdentity(
    credential: AuthGateCredential,
    signal: AbortSignal,
  ): Promise<IdentityCheckResult>;
  /** Unix seconds. */
  now(): number;
}

export type AuthGateOutcome =
  | {
    readonly kind: "pass";
    readonly authMode: AuthMode;
    /** The verified whoami response, when the gate called swamp-club. */
    readonly liveResponse?: WhoamiResponse;
    /** Shown once logging is up, when the run proceeds unverified. */
    readonly warning?: string;
    /** The weekly refresh, present when the file proof is due one. */
    readonly refresh?: () => Promise<void>;
  }
  | { readonly kind: "block"; readonly reason: BlockReason };

interface ProofAssessment {
  readonly verdict: LocalProofVerdict;
  /** The fingerprint the valid signin-token proof was issued for. */
  readonly tokenFpr?: string;
  /** True when the file proof belongs to the active key (or is unreadable). */
  readonly fileProofIsActiveKeys: boolean;
}

/**
 * Verify every proof on hand against the active key and keep the best:
 * the first valid one, else an expired one issued for this key (so the
 * block can say how long it has been), else missing or invalid.
 */
async function assessProofs(
  candidates: readonly ProofCandidate[],
  apiKey: string,
  now: number,
): Promise<ProofAssessment> {
  const activeFpr = await computeProofFingerprint(apiKey);
  let expired: LocalProofVerdict | undefined;
  let invalidReason: string | undefined;
  let fileProofIsActiveKeys = false;

  for (const { source, verification } of candidates) {
    const payload = parseProofPayload(verification.proof);
    if (source === "file") {
      fileProofIsActiveKeys = !payload || payload.fpr === activeFpr;
    }
    const result = await verifyProof(
      verification.proof,
      verification.signature,
      verification.publicKeys,
      apiKey,
      now,
    );
    if (result.valid && payload) {
      return {
        verdict: { kind: "valid", source, issuedAt: payload.iat },
        tokenFpr: source === "signin_token" ? payload.fpr : undefined,
        fileProofIsActiveKeys: source === "file"
          ? true
          : fileMatches(candidates, activeFpr),
      };
    }
    if (
      !result.valid && result.reason === "proof expired" && payload &&
      payload.fpr === activeFpr && !expired
    ) {
      expired = { kind: "expired", issuedAt: payload.iat };
    } else if (!result.valid) {
      invalidReason ??= result.reason;
    }
  }

  const verdict: LocalProofVerdict = expired ??
    (invalidReason !== undefined
      ? { kind: "invalid", reason: invalidReason }
      : { kind: "missing" });
  return { verdict, fileProofIsActiveKeys };
}

function fileMatches(
  candidates: readonly ProofCandidate[],
  activeFpr: string,
): boolean {
  const file = candidates.find((c) => c.source === "file");
  if (!file) return false;
  const payload = parseProofPayload(file.verification.proof);
  return !payload || payload.fpr === activeFpr;
}

async function applyEffects(
  effects: GateEffects,
  deps: AuthGateDeps,
  context: {
    readonly response?: WhoamiResponse;
    readonly tokenFpr?: string;
    readonly fileProofIsActiveKeys: boolean;
    readonly now: number;
  },
): Promise<void> {
  const repo = deps.verificationRepo;
  const { response } = context;
  // Every write is best effort: a read-only config dir must not fail a run
  // the policy already decided. The decision never depends on a write.
  const attempt = async (write: () => Promise<void>) => {
    try {
      await write();
    } catch {
      // Best effort — see above.
    }
  };
  if (
    effects.saveProof && response?.verificationProof &&
    response.verificationSignature && response.publicKeys
  ) {
    const { verificationProof, verificationSignature, publicKeys } = response;
    await attempt(() =>
      repo.save(verificationProof, verificationSignature, publicKeys)
    );
  }
  if (effects.deleteFileProof && context.fileProofIsActiveKeys) {
    await attempt(() => repo.delete());
  }
  if (effects.markFailOpen) {
    await attempt(() => repo.markFailOpenSince(context.now));
  }
  if (effects.clearFailOpen) {
    await attempt(() => repo.clearFailOpen());
  }
  if (effects.recordTokenCheck && context.tokenFpr) {
    const tokenFpr = context.tokenFpr;
    await attempt(() => repo.recordTokenCheck(tokenFpr, context.now));
  }
  if (effects.clearTokenCheck) {
    await attempt(() => repo.clearTokenCheck());
  }
}

/**
 * Decide whether this invocation may run. Reads the credential and proofs,
 * asks the policy, calls swamp-club only when the policy says to, and
 * records what the answer changes (a fresh proof, a revoked key, the
 * fail-open window, a verified signin token).
 */
export async function runAuthGate(
  deps: AuthGateDeps,
): Promise<AuthGateOutcome> {
  const credential = await deps.loadCredential();
  const now = deps.now();
  const repo = deps.verificationRepo;

  if (!credential) {
    const decision = decideBeforeCheck({
      credentialPresent: false,
      proof: { kind: "missing" },
      now,
    });
    // The policy always blocks a run with no credential.
    return {
      kind: "block",
      reason: decision.kind === "block"
        ? decision.reason
        : { kind: "no_credential" },
    };
  }
  const { apiKey } = credential;

  const assessment = await assessProofs(
    await repo.loadCandidates(),
    apiKey,
    now,
  );
  const { verdict } = assessment;
  const lastTokenCheckAt = assessment.tokenFpr
    ? await repo.readTokenCheck(assessment.tokenFpr)
    : undefined;

  const before = decideBeforeCheck({
    credentialPresent: true,
    proof: verdict,
    lastTokenCheckAt,
    now,
  });
  const refresh = shouldRefresh(verdict, now, await repo.readRefreshAttempt())
    ? () => runProofRefresh(deps)
    : undefined;
  if (before.kind === "block") return { kind: "block", reason: before.reason };
  if (before.kind === "pass") {
    return { kind: "pass", authMode: before.authMode, refresh };
  }

  const timeoutMs = before.timeout === "blocking"
    ? BLOCKING_CHECK_TIMEOUT_MS
    : SHORT_CHECK_TIMEOUT_MS;
  const result = await deps.verifyIdentity(
    credential,
    AbortSignal.timeout(timeoutMs),
  );
  const { decision, effects } = decideAfterCheck({
    proof: verdict,
    outcome: result.outcome,
    failOpenSince: await repo.readFailOpenSince(),
    now,
  });
  await applyEffects(effects, deps, {
    response: result.response,
    tokenFpr: assessment.tokenFpr,
    fileProofIsActiveKeys: assessment.fileProofIsActiveKeys,
    now,
  });

  if (decision.kind === "block") {
    return { kind: "block", reason: decision.reason };
  }
  return {
    kind: "pass",
    authMode: decision.authMode,
    liveResponse: result.outcome.kind === "verified"
      ? result.response
      : undefined,
    warning: decision.authMode === "offline"
      ? offlineWarning(result.outcome.kind, verdict.kind === "valid")
      : undefined,
  };
}

function offlineWarning(
  outcome: IdentityCheckResult["outcome"]["kind"],
  hasProof: boolean,
): string {
  const why = outcome === "server_error"
    ? "swamp-club.com is returning errors"
    : "could not reach swamp-club.com";
  return hasProof
    ? `Running with offline identity: ${why}.`
    : `Running unverified for up to 24 hours: ${why}. swamp will block once ` +
      `it has been unable to verify you for a day.`;
}

/**
 * The weekly background refresh: re-verify a file proof older than seven
 * days. It never changes the run that already passed. A rejection deletes
 * the proof so the next command blocks; any failure keeps it for next time.
 */
export async function runProofRefresh(deps: AuthGateDeps): Promise<void> {
  const credential = await deps.loadCredential();
  if (!credential) return;
  const assessment = await assessProofs(
    await deps.verificationRepo.loadCandidates(),
    credential.apiKey,
    deps.now(),
  );
  const now = deps.now();
  // Recorded before the call, so a refresh that never answers still waits an
  // hour before the next attempt.
  try {
    await deps.verificationRepo.recordRefreshAttempt(now);
  } catch {
    // Best effort — without the stamp the next run simply tries again.
  }
  const result = await deps.verifyIdentity(
    credential,
    AbortSignal.timeout(SHORT_CHECK_TIMEOUT_MS),
  );
  await applyEffects(refreshEffects(result.outcome), deps, {
    response: result.response,
    fileProofIsActiveKeys: assessment.fileProofIsActiveKeys,
    now,
  });
}

/**
 * The gate's real dependencies. With `liveChecks: false` (hook mode, which
 * must stay fast and never touch the network) every live check reports
 * swamp-club unreachable, so only a locally valid proof lets the run through.
 */
export function createAuthGateDeps(
  options: { liveChecks: boolean },
): AuthGateDeps {
  return {
    loadCredential: async () => {
      let credentials;
      try {
        credentials = await new AuthRepository().load();
      } catch (error) {
        // A misconfigured key source (a missing key file, both env vars set)
        // is reported by name. Anything else is no config dir at all — no
        // HOME — which holds no credential.
        if (error instanceof UserError) throw error;
        return null;
      }
      return credentials?.apiKey
        ? { apiKey: credentials.apiKey, serverUrl: credentials.serverUrl }
        : null;
    },
    verificationRepo: new AuthVerificationRepository(),
    verifyIdentity: async (credential, signal) => {
      if (!options.liveChecks) {
        return { outcome: { kind: "unreachable", reason: "hook mode" } };
      }
      const client = new SwampClubClient(
        credential.serverUrl,
        await loadIdentity(),
      );
      return await client.verifyIdentity(credential.apiKey, signal);
    },
    now: () => Math.floor(Date.now() / 1000),
  };
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** A Retry-After wait in the largest whole unit: 45s, 2 minutes, 1 hour. */
function formatWait(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 2 * 3600) return plural(Math.ceil(seconds / 60), "minute");
  return plural(Math.ceil(seconds / 3600), "hour");
}

const LOGIN_HINT = "Run `swamp auth login` to sign in again.";

/** The message a blocked run exits with, per the design's user experience. */
export function blockMessage(reason: BlockReason): string {
  switch (reason.kind) {
    case "no_credential":
      return [
        "swamp requires a swamp-club.com account to run.",
        "",
        "  Run `swamp auth login` to create an account or sign in.",
        "  It takes about 30 seconds.",
        "",
        "  In CI, set SWAMP_API_KEY and SWAMP_SIGNIN_TOKEN from a collective",
        "  token created at swamp-club.com/collectives.",
        "",
        "  For a serve or worker daemon, sign in as the user that enabled it",
        "  and re-run `swamp serve daemon enable` or `swamp worker daemon enable`.",
      ].join("\n");
    case "revoked":
      return [
        "Your swamp-club.com credentials have been revoked.",
        "",
        "  This can happen if your API key was deleted or your account was",
        "  suspended.",
        "",
        `  ${LOGIN_HINT}`,
      ].join("\n");
    case "refused": {
      const wait = reason.retryAfterSeconds !== undefined
        ? ` Retry in ${formatWait(reason.retryAfterSeconds)}.`
        : " Try again shortly.";
      return [
        "Could not verify your identity: swamp-club.com refused the check.",
        "",
        `  It is limiting or blocking requests from this network.${wait}`,
        "  Once verified, swamp keeps working through swamp-club outages.",
      ].join("\n");
    }
    case "unreachable_unverified":
      return reason.daysSinceVerification !== undefined
        ? [
          `Your identity hasn't been verified in ${
            plural(reason.daysSinceVerification, "day")
          }.`,
          "",
          "  swamp needs to check in with swamp-club.com periodically.",
          "  Please check your network connection and try again.",
        ].join("\n")
        : [
          "Could not reach swamp-club.com to verify your identity.",
          "",
          "  swamp verifies your credentials once before it can run offline.",
          "  Please check your network connection and try again.",
        ].join("\n");
    case "unverified_for_a_day":
      return [
        "Could not verify your identity: swamp-club.com has been failing for",
        "over 24 hours.",
        "",
        "  swamp runs unverified for at most a day. Please try again later.",
      ].join("\n");
  }
}

/**
 * The error a blocked run exits with. Telemetry records the class name and
 * the message's first line, so blocks are countable by type and reason.
 */
export class AuthGateBlockedError extends UserError {
  readonly reason: BlockReason;
  constructor(reason: BlockReason) {
    super(blockMessage(reason), "auth_gate_blocked");
    this.name = "AuthGateBlockedError";
    this.reason = reason;
  }
}
