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
import { AuthGateBlockedError } from "../domain/auth/auth_gate_blocked_error.ts";
import {
  type AuthMode,
  type BlockReason,
  decideAfterCheck,
  decideBeforeCheck,
  type GateEffects,
  type LocalProofVerdict,
  type NestedPassVerdict,
  refreshEffects,
  shouldRefresh,
} from "../domain/auth/auth_gate_policy.ts";
import {
  verifyProof,
  verifyProofSignature,
} from "../domain/auth/proof_verifier.ts";
import {
  admitsNestedRun,
  formatNestedGatePass,
  NESTED_GATE_PASS_ENV,
  type NestedGatePass,
  parseNestedGatePass,
} from "../domain/auth/nested_gate_pass.ts";
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
import { getSwampConfigDir } from "../infrastructure/persistence/paths.ts";
import {
  AuthVerificationRepository,
  type ProofCandidate,
} from "../infrastructure/persistence/auth_verification_repository.ts";
import {
  findAncestor,
  isSameExecutable,
} from "../infrastructure/runtime/process_ancestry.ts";
import { loadIdentity } from "./load_identity.ts";

/** How long the gate waits for swamp-club when there is no valid proof. */
export const BLOCKING_CHECK_TIMEOUT_MS = 10_000;
/** How long it waits for a signin-token check or the weekly refresh. */
export const SHORT_CHECK_TIMEOUT_MS = 3_000;

export interface AuthGateCredential {
  readonly apiKey: string;
  readonly serverUrl: string;
}

/** Whether a nested pass's issuer is a live ancestor of this process. */
export type AncestorCheck =
  | {
    readonly kind: "ok";
    /** When the ancestor started, in Unix seconds. */
    readonly startedAt: number;
  }
  | { readonly kind: "failed"; readonly reason: string };

/** What the gate needs to accept a nested pass (design: "Nested runs"). */
export interface NestedGateDeps {
  /** The pass inherited from a parent swamp, if any. */
  loadPass(): NestedGatePass | null;
  /** Whether `pid` is a live ancestor running this process's executable. */
  checkAncestor(pid: number): AncestorCheck;
}

/** The signed proof a pass rests on, handed down to nested runs. */
export interface GateHandoff {
  readonly proof: string;
  readonly signature: string;
  /**
   * The pid the inherited pass names, when this run passed on one. The pass
   * is handed on unchanged, so every descendant judges the proof against the
   * swamp that was admitted on it, not against this later one.
   */
  readonly issuerPid?: number;
}

/**
 * The SWAMP_NESTED_GATE_PASS value a run that passed hands to the swamps it
 * starts, or undefined when it has nothing to hand down. A run admitted on
 * its own proof names itself; one admitted on an inherited pass passes that
 * pass on, still naming the original issuer.
 */
export function nestedGatePassValue(
  handoff: GateHandoff | undefined,
  ownPid: number,
): string | undefined {
  if (!handoff) return undefined;
  return formatNestedGatePass({
    parentPid: handoff.issuerPid ?? ownPid,
    proof: handoff.proof,
    signature: handoff.signature,
  });
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
  /**
   * False when this process does not own the config dir — a system-mode
   * daemon running as root against the enabling user's dir. The gate then
   * reads but never writes there, so it leaves no root-owned files the user
   * cannot read back. Defaults to true.
   */
  readonly canWrite?: boolean;
  /** Omitted, no nested pass is ever accepted. */
  readonly nested?: NestedGateDeps;
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
    /**
     * The proof nested runs inherit: a fresh whoami proof, else the valid
     * file proof, else the proof this run itself inherited. Never a
     * signin-token proof. Absent when there is no such proof, for example a
     * run that passed offline on its signin token alone.
     */
    readonly handoff?: GateHandoff;
  }
  | { readonly kind: "block"; readonly reason: BlockReason };

interface ProofAssessment {
  readonly verdict: LocalProofVerdict;
  /** The fingerprint the valid signin-token proof was issued for. */
  readonly tokenFpr?: string;
  /**
   * The proof a nested run may inherit: the valid file proof, never a
   * signin-token proof (see {@link validFileProof}).
   */
  readonly handoffProof?: GateHandoff;
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
        handoffProof: source === "file"
          ? { proof: verification.proof, signature: verification.signature }
          : await validFileProof(candidates, apiKey, now),
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

/**
 * The file proof when it verifies for the active key. A run that passed on
 * its signin token hands this down instead: the token is a CI secret that
 * method children must never see (swamp-club#2032), under any name.
 */
async function validFileProof(
  candidates: readonly ProofCandidate[],
  apiKey: string,
  now: number,
): Promise<GateHandoff | undefined> {
  const file = candidates.find((c) => c.source === "file");
  if (!file) return undefined;
  const { proof, signature, publicKeys } = file.verification;
  const result = await verifyProof(proof, signature, publicKeys, apiKey, now);
  return result.valid ? { proof, signature } : undefined;
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

/**
 * Record what a live check changed. Returns whether the fail-open window was
 * recorded, so the warning can say when the 24-hour limit cannot apply.
 */
async function applyEffects(
  effects: GateEffects,
  deps: AuthGateDeps,
  context: {
    readonly response?: WhoamiResponse;
    readonly tokenFpr?: string;
    readonly fileProofIsActiveKeys: boolean;
    readonly now: number;
  },
): Promise<boolean> {
  if (deps.canWrite === false) return false;
  const repo = deps.verificationRepo;
  const { response } = context;
  // Every write is best effort: a read-only config dir must not fail a run
  // the policy already decided. The decision never depends on a write.
  const attempt = async (write: () => Promise<void>): Promise<boolean> => {
    try {
      await write();
      return true;
    } catch {
      // Best effort — see above.
      return false;
    }
  };
  let failOpenRecorded = false;
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
    failOpenRecorded = await attempt(() => repo.markFailOpenSince(context.now));
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
  return failOpenRecorded;
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
    const nested = await assessNestedPass(deps, now);
    const decision = decideBeforeCheck({
      credentialPresent: false,
      proof: { kind: "missing" },
      nestedPass: nested.verdict,
      now,
    });
    if (decision.kind === "pass" && nested.handoff) {
      return {
        kind: "pass",
        authMode: decision.authMode,
        handoff: nested.handoff,
      };
    }
    // Without a credential the policy passes only on a valid nested pass.
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
  // The refresh exists only to save or delete the proof, so a process that
  // may not write to the config dir skips it.
  const refresh = deps.canWrite !== false &&
      shouldRefresh(verdict, now, await repo.readRefreshAttempt())
    ? () => runProofRefresh(deps)
    : undefined;
  if (before.kind === "block") return { kind: "block", reason: before.reason };
  if (before.kind === "pass") {
    return {
      kind: "pass",
      authMode: before.authMode,
      refresh,
      handoff: assessment.handoffProof,
    };
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
  const failOpenRecorded = await applyEffects(effects, deps, {
    response: result.response,
    tokenFpr: assessment.tokenFpr,
    fileProofIsActiveKeys: assessment.fileProofIsActiveKeys,
    now,
  });

  if (decision.kind === "block") {
    return { kind: "block", reason: decision.reason };
  }
  const liveResponse = result.outcome.kind === "verified"
    ? result.response
    : undefined;
  return {
    kind: "pass",
    authMode: decision.authMode,
    liveResponse,
    handoff: liveProof(liveResponse) ?? assessment.handoffProof,
    warning: decision.authMode === "offline"
      ? offlineWarning(
        result.outcome.kind,
        verdict.kind === "valid",
        effects.markFailOpen && !failOpenRecorded,
      )
      : undefined,
  };
}

/** The fresh proof a verified whoami answer carried, if any. */
function liveProof(response?: WhoamiResponse): GateHandoff | undefined {
  return response?.verificationProof && response.verificationSignature
    ? {
      proof: response.verificationProof,
      signature: response.verificationSignature,
    }
    : undefined;
}

interface NestedAssessment {
  readonly verdict: NestedPassVerdict;
  readonly handoff?: GateHandoff;
}

/**
 * Check a pass inherited from a parent swamp: swamp-club signed its proof
 * (checked against the keys the gate already trusts, never a key the pass
 * supplies) and the pid that issued it is a live ancestor running this same
 * executable. `exp` is judged at the ancestor's start, not now: the ancestor
 * was admitted on this proof and runs on it for its whole life, so its
 * children may too, but a proof that had expired before the ancestor started
 * (or has no `exp` at all) admits nothing.
 */
async function assessNestedPass(
  deps: AuthGateDeps,
  now: number,
): Promise<NestedAssessment> {
  const pass = deps.nested?.loadPass();
  if (!deps.nested || !pass) return { verdict: { kind: "absent" } };

  const candidates = await deps.verificationRepo.loadCandidates();
  const cachedKeys =
    candidates.find((c) => c.source === "file")?.verification.publicKeys ?? [];
  const signature = await verifyProofSignature(
    pass.proof,
    pass.signature,
    cachedKeys,
    { now, ignoreExpiry: true },
  );
  if (!signature.valid) {
    return { verdict: { kind: "invalid", reason: signature.reason } };
  }

  const ancestor = deps.nested.checkAncestor(pass.parentPid);
  if (ancestor.kind === "failed") {
    return { verdict: { kind: "invalid", reason: ancestor.reason } };
  }
  if (!admitsNestedRun(signature.payload, ancestor.startedAt)) {
    return {
      verdict: {
        kind: "invalid",
        reason: "proof has no exp, or expired before its issuer started",
      },
    };
  }
  return {
    verdict: { kind: "valid" },
    handoff: {
      proof: pass.proof,
      signature: pass.signature,
      issuerPid: pass.parentPid,
    },
  };
}

/** The manual page covering CI credentials and daemons. */
const ACCOUNT_REQUIREMENT_URL =
  "https://swamp-club.com/manual/reference/swamp-account-requirement";

/**
 * `windowUnrecorded` is true when this run should have started the 24-hour
 * fail-open window but could not record it (a read-only config dir, or a
 * process that does not own it). The run still passes — the stamp is not a
 * security boundary (design/surfaces/auth-gate.md) — but the warning must not
 * promise a limit that cannot apply.
 */
function offlineWarning(
  outcome: IdentityCheckResult["outcome"]["kind"],
  hasProof: boolean,
  windowUnrecorded: boolean,
): string {
  const why = outcome === "server_error"
    ? "swamp-club.com is returning errors"
    : "could not reach swamp-club.com";
  if (hasProof) {
    return `Running offline (${why}); using your cached verification.`;
  }
  if (windowUnrecorded) {
    return `Running unverified: ${why}, and swamp cannot record when this ` +
      `started because this process cannot write its config dir. See ` +
      `${ACCOUNT_REQUIREMENT_URL}`;
  }
  return `Running unverified for up to 24 hours: ${why}. swamp will block ` +
    `once it has been unable to verify you for a day.`;
}

/**
 * The weekly background refresh: re-verify a file proof older than seven
 * days. It never changes the run that already passed. A rejection deletes
 * the proof so the next command blocks; any failure keeps it for next time.
 */
export async function runProofRefresh(deps: AuthGateDeps): Promise<void> {
  const credential = await deps.loadCredential();
  if (!credential) return;
  const now = deps.now();
  const assessment = await assessProofs(
    await deps.verificationRepo.loadCandidates(),
    credential.apiKey,
    now,
  );
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
  options: { liveChecks: boolean; canWrite: boolean },
): AuthGateDeps {
  return {
    loadCredential: async () => {
      let hasConfigDir = true;
      try {
        getSwampConfigDir();
      } catch {
        hasConfigDir = false;
      }
      let credentials;
      try {
        credentials = await new AuthRepository().load();
      } catch (error) {
        // With no config dir at all (no HOME) there is no stored credential,
        // which is "no account". Anything else — a misconfigured key source,
        // an auth.json the user cannot read — is reported as itself, so the
        // message points at the real fix rather than at `auth login`.
        if (!hasConfigDir && !(error instanceof UserError)) return null;
        throw error;
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
    canWrite: options.canWrite,
    nested: {
      loadPass: () => {
        const value = Deno.env.get(NESTED_GATE_PASS_ENV);
        return value ? parseNestedGatePass(value) : null;
      },
      checkAncestor: (pid) => {
        const ancestor = findAncestor(pid);
        if (ancestor.kind === "not_ancestor") {
          return { kind: "failed", reason: `pid ${pid} is not an ancestor` };
        }
        if (ancestor.kind === "unknown") {
          return { kind: "failed", reason: ancestor.reason };
        }
        return isSameExecutable(ancestor.executablePath, Deno.execPath())
          ? { kind: "ok", startedAt: ancestor.startedAt }
          : {
            kind: "failed",
            reason: `pid ${pid} runs a different executable`,
          };
      },
    },
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
        "",
        "  In CI, set SWAMP_API_KEY and SWAMP_SIGNIN_TOKEN. For CI and daemons,",
        `  see ${ACCOUNT_REQUIREMENT_URL}`,
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
        ? `Retry in ${formatWait(reason.retryAfterSeconds)}.`
        : "Try again shortly.";
      return [
        "Could not verify your identity: swamp-club.com, or a proxy between",
        `you and it, refused the check (HTTP ${reason.status}).`,
        "",
        `  ${wait} If you are behind a corporate proxy, check that it allows`,
        "  swamp-club.com. Once verified, swamp keeps working through",
        "  swamp-club outages.",
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
          "  Check your network connection and try again. `swamp auth whoami`",
          "  works without verification and shows what swamp-club.com returns.",
        ].join("\n")
        : [
          "Could not reach swamp-club.com to verify your identity.",
          "",
          "  swamp verifies your credentials once before it can run offline.",
          "  Check your network connection and try again. `swamp auth whoami`",
          "  works without verification and shows what swamp-club.com returns.",
        ].join("\n");
    case "unverified_for_a_day":
      return [
        "Could not verify your identity: swamp-club.com has been failing for",
        "over 24 hours.",
        "",
        "  swamp runs unverified for at most a day. Please try again later.",
        "  `swamp auth whoami` works without verification and shows what",
        "  swamp-club.com returns.",
      ].join("\n");
  }
}

/** The error a blocked run exits with, carrying the design's message. */
export function authGateBlockedError(
  reason: BlockReason,
): AuthGateBlockedError {
  return new AuthGateBlockedError(reason, blockMessage(reason));
}
