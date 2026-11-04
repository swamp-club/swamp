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

import { UserError } from "../../domain/errors.ts";
import { AuthGateBlockedError } from "../../domain/auth/auth_gate_blocked_error.ts";
import {
  type AuthMode,
  type BlockReason,
  decideAfterCheck,
  decideBeforeCheck,
  type GateEffects,
  type IdentityCheckOutcome,
  type LocalProofVerdict,
  type NestedPassVerdict,
  REFRESH_AFTER_SECONDS,
  REFRESH_RETRY_SECONDS,
  refreshEffects,
  shouldRefresh,
} from "../../domain/auth/auth_gate_policy.ts";
import {
  verifyProof,
  verifyProofSignature,
} from "../../domain/auth/proof_verifier.ts";
import {
  admitsNestedRun,
  formatNestedGatePass,
  NESTED_GATE_PASS_ENV,
  type NestedGatePass,
  type OrchestratorGatePass,
  parseNestedGatePass,
  parseOrchestratorGatePass,
} from "../../domain/auth/nested_gate_pass.ts";
import {
  computeProofFingerprint,
  parseProofPayload,
} from "../../domain/auth/verification_proof.ts";
import {
  type IdentityCheckResult,
  SwampClubClient,
  type WhoamiResponse,
} from "../../infrastructure/http/swamp_club_client.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { getSwampConfigDir } from "../../infrastructure/persistence/paths.ts";
import {
  AuthVerificationRepository,
  type ProofCandidate,
} from "../../infrastructure/persistence/auth_verification_repository.ts";
import {
  findAncestor,
  isSameExecutable,
} from "../../infrastructure/runtime/process_ancestry.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";

export const BLOCKING_CHECK_TIMEOUT_MS = 10_000;
export const SHORT_CHECK_TIMEOUT_MS = 3_000;

export interface AuthGateCredential {
  readonly apiKey: string;
  readonly serverUrl: string;
}

export type AncestorCheck =
  | {
    readonly kind: "ok";
    readonly startedAt: number;
  }
  | { readonly kind: "failed"; readonly reason: string };

export interface NestedGateDeps {
  loadPass(): NestedGatePass | null;
  checkAncestor(pid: number): AncestorCheck;
}

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
 * a run admitted on its own proof names itself; one admitted on an inherited
 * pass passes that pass on, still naming the original issuer.
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
  loadCredential(): Promise<AuthGateCredential | null>;
  readonly verificationRepo: AuthVerificationRepository;
  verifyIdentity(
    credential: AuthGateCredential,
    signal: AbortSignal,
  ): Promise<IdentityCheckResult>;
  now(): number;
  /**
   * false when this process does not own the config dir (a system-mode daemon
   * as root): the gate reads but never writes there, so it leaves no root-owned
   * files the user cannot read. Defaults to true.
   */
  readonly canWrite?: boolean;
  /** Omitted, no nested pass is ever accepted. */
  readonly nested?: NestedGateDeps;
}

export type AuthGateOutcome =
  | {
    readonly kind: "pass";
    readonly authMode: AuthMode;
    readonly liveResponse?: WhoamiResponse;
    readonly warning?: string;
    readonly refresh?: () => Promise<void>;
    /**
     * the proof nested runs inherit: a fresh whoami proof, else the valid file
     * proof, else the one this run inherited; never a signin-token proof.
     */
    readonly handoff?: GateHandoff;
  }
  | { readonly kind: "block"; readonly reason: BlockReason };

interface ProofAssessment {
  readonly verdict: LocalProofVerdict;
  readonly tokenFpr?: string;
  /**
   * The proof a nested run may inherit: the valid file proof, never a
   * signin-token proof (see {@link validFileProof}).
   */
  readonly handoffProof?: GateHandoff;
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
 * the file proof when it verifies for the active key. A run on a signin token
 * hands this down instead, because the token is a CI secret method children
 * must never see.
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
    ? async () => {
      await runProofRefresh(deps);
    }
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
 * swamp-club must have signed the pass (against trusted keys, never one the
 * pass supplies) and its issuer pid be a live ancestor; exp is judged at the
 * ancestor's start, absent or expired admits nothing
 */
async function assessNestedPass(
  deps: AuthGateDeps,
  now: number,
): Promise<NestedAssessment> {
  const pass = deps.nested?.loadPass();
  if (!deps.nested || !pass) return { verdict: { kind: "absent" } };

  const signature = await verifyWithTrustedKeys(
    deps.verificationRepo,
    pass,
    now,
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

/**
 * Check a handed-over proof's signature against the keys the gate already
 * trusts: those cached with the file proof, then the embedded key. Never a
 * key the pass supplies. Expiry is the caller's rule, so it is ignored here.
 */
async function verifyWithTrustedKeys(
  repo: AuthVerificationRepository,
  pass: OrchestratorGatePass,
  now: number,
): ReturnType<typeof verifyProofSignature> {
  const candidates = await repo.loadCandidates();
  const cachedKeys =
    candidates.find((c) => c.source === "file")?.verification.publicKeys ?? [];
  return await verifyProofSignature(pass.proof, pass.signature, cachedKeys, {
    now,
    ignoreExpiry: true,
  });
}

export type OrchestratorBlockCause =
  | "no_pass"
  | "serve_without_proof"
  | "expired_pass"
  | "rejected_pass";

export type OrchestratorAdmission =
  | {
    readonly kind: "pass";
    readonly handoff: GateHandoff;
  }
  | {
    readonly kind: "block";
    readonly cause: OrchestratorBlockCause;
    readonly detail: string;
  };

/**
 * the serve stands in for the ancestry check; swamp-club must have signed the
 * proof against trusted keys and exp must be later than gateTime. The handoff
 * has no issuer pid, so the worker names itself
 */
export async function admitOrchestratorPass(
  repo: AuthVerificationRepository,
  passValue: string | undefined,
  gateTime: number,
  serveRefused = false,
): Promise<OrchestratorAdmission> {
  if (serveRefused) {
    return {
      kind: "block",
      cause: "serve_without_proof",
      detail: "the orchestrator has no signed pass to give",
    };
  }
  if (passValue === undefined) {
    return {
      kind: "block",
      cause: "no_pass",
      detail: "the orchestrator sent no pass",
    };
  }
  const pass = parseOrchestratorGatePass(passValue);
  if (!pass) {
    return {
      kind: "block",
      cause: "rejected_pass",
      detail: "the orchestrator's pass is malformed",
    };
  }
  const signature = await verifyWithTrustedKeys(repo, pass, gateTime);
  if (!signature.valid) {
    return {
      kind: "block",
      cause: "rejected_pass",
      detail: "the orchestrator's pass is not signed by a swamp-club key " +
        "this worker trusts",
    };
  }
  if (!admitsNestedRun(signature.payload, gateTime)) {
    return {
      kind: "block",
      cause: "expired_pass",
      detail: "the orchestrator's pass had expired when this worker reached " +
        "the gate",
    };
  }
  return {
    kind: "pass",
    handoff: { proof: pass.proof, signature: pass.signature },
  };
}

/**
 * keeps the pass a serve hands enrolling workers fresh, since the weekly
 * refresh otherwise runs only at exit. Refreshed proofs are held in memory, and
 * a rejection drops it so the serve stops vouching.
 */
export interface GatePassKeeper {
  current(): OrchestratorGatePass | undefined;
  tick(): Promise<void>;
  /** Check every `intervalMs`, unref'd so it never holds the process open. */
  start(intervalMs: number): void;
  stop(): Promise<void>;
}

export const GATE_PASS_KEEPER_INTERVAL_MS = 60 * 60 * 1000;

export function createGatePassKeeper(
  deps: AuthGateDeps,
  initial: GateHandoff | undefined,
): GatePassKeeper {
  let held: OrchestratorGatePass | undefined = initial
    ? { proof: initial.proof, signature: initial.signature }
    : undefined;
  let lastAttemptAt: number | undefined;
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const due = (now: number): boolean => {
    if (!held) return false;
    const issuedAt = parseProofPayload(held.proof)?.iat;
    if (issuedAt === undefined || now - issuedAt <= REFRESH_AFTER_SECONDS) {
      return false;
    }
    return lastAttemptAt === undefined ||
      now - lastAttemptAt >= REFRESH_RETRY_SECONDS;
  };

  const check = async (): Promise<void> => {
    const now = deps.now();
    if (!due(now)) return;
    lastAttemptAt = now;
    const result = await runProofRefresh(deps);
    if (!result) return;
    if (result.outcome.kind === "rejected") {
      held = undefined;
    } else if (result.proof) {
      held = { proof: result.proof.proof, signature: result.proof.signature };
    }
  };

  const tick = (): Promise<void> => {
    inFlight ??= check().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    current: () => held,
    tick,
    start(intervalMs) {
      const interval = setInterval(() => {
        tick().catch(() => {
          // Best effort — the held proof is kept for the next check.
        });
      }, intervalMs);
      Deno.unrefTimer(interval);
      timer = interval;
    },
    async stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await inFlight?.catch(() => {});
    },
  };
}

const ACCOUNT_REQUIREMENT_URL =
  "https://swamp-club.com/manual/reference/swamp-account-requirement";

/**
 * true when the 24-hour fail-open window could not be recorded (read-only or
 * unowned config dir). The run still passes, since the stamp is not a security
 * boundary, but the warning must not promise a limit that cannot apply.
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
      `started because this process does not write its config dir. See ` +
      `${ACCOUNT_REQUIREMENT_URL}`;
  }
  return `Running unverified for up to 24 hours: ${why}. swamp will block ` +
    `once it has been unable to verify you for a day.`;
}

export interface ProofRefreshResult {
  readonly outcome: IdentityCheckOutcome;
  readonly proof?: GateHandoff;
}

/**
 * the weekly background refresh never changes the run that already passed. A
 * rejection deletes the proof so the next command blocks; any other failure
 * keeps it.
 */
export async function runProofRefresh(
  deps: AuthGateDeps,
): Promise<ProofRefreshResult | undefined> {
  const credential = await deps.loadCredential();
  if (!credential) return undefined;
  const now = deps.now();
  const assessment = await assessProofs(
    await deps.verificationRepo.loadCandidates(),
    credential.apiKey,
    now,
  );
  // Recorded before the call, so a refresh that never answers still waits an
  // hour before the next attempt.
  if (deps.canWrite !== false) {
    try {
      await deps.verificationRepo.recordRefreshAttempt(now);
    } catch {
      // Best effort — without the stamp the next run simply tries again.
    }
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
  return {
    outcome: result.outcome,
    proof: result.outcome.kind === "verified"
      ? liveProof(result.response)
      : undefined,
  };
}

/**
 * with liveChecks false (hook mode, which must stay fast and never touch the
 * network) every live check reports swamp-club unreachable, so only a locally
 * valid proof passes.
 */
export function createAuthGateDeps(
  options: { liveChecks: boolean; canWrite: boolean },
  loadIdentity: () => Promise<ClientIdentity>,
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
        // no config dir (no HOME) means no stored credential; anything else,
        // such as a bad key source or unreadable auth.json, is reported as
        // itself so the message points at the real fix.
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

function formatWait(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 2 * 3600) return plural(Math.ceil(seconds / 60), "minute");
  return plural(Math.ceil(seconds / 3600), "hour");
}

const LOGIN_HINT = "Run `swamp auth login` to sign in again.";

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

export function orchestratorBlockedError(
  cause: OrchestratorBlockCause,
  detail: string,
): AuthGateBlockedError {
  const fix = {
    no_pass: [
      "  The orchestrator's swamp may predate worker gate passes: upgrade it.",
    ],
    serve_without_proof: [
      "  The orchestrator passed the gate without a signed proof of its own",
      "  (offline, or on a signin token alone): restart it online on its own",
      "  swamp-club key.",
    ],
    expired_pass: [
      "  The orchestrator could not refresh its pass: check that it can reach",
      "  swamp-club.com, or restart it.",
    ],
    rejected_pass: [
      "  Run `swamp update` on the worker and the orchestrator so both trust",
      "  the same swamp-club keys.",
    ],
  }[cause];
  const remedy = [
    ...fix,
    "  Or give the worker a credential (SWAMP_API_KEY_FILE). See",
    `  ${ACCOUNT_REQUIREMENT_URL}`,
  ];
  return new AuthGateBlockedError(
    { kind: "no_credential" },
    [
      "swamp requires a swamp-club.com account to run.",
      "",
      "  This worker has no credential of its own, and the orchestrator it",
      `  enrolled with did not vouch for it: ${detail}.`,
      "",
      ...remedy,
    ].join("\n"),
  );
}

export function authGateBlockedError(
  reason: BlockReason,
): AuthGateBlockedError {
  return new AuthGateBlockedError(reason, blockMessage(reason));
}

/**
 * Hand this run's pass down to any swamp it starts (design/surfaces/
 * auth-gate.md, "Nested runs"), through the process env as
 * SWAMP_LOCK_HOLDER_PID is (see `nestedGatePassValue`). A run with nothing
 * to hand down clears any pass it inherited. Set once per process: when the
 * gate passes, or for a worker without a credential, when its orchestrator
 * admits it.
 */
export function publishNestedGatePass(handoff: GateHandoff | undefined): void {
  const value = nestedGatePassValue(handoff, Deno.pid);
  if (value) {
    Deno.env.set(NESTED_GATE_PASS_ENV, value);
  } else {
    Deno.env.delete(NESTED_GATE_PASS_ENV);
  }
}
