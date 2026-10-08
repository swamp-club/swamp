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
 * The auth gate's handoff to a nested swamp (design/surfaces/auth-gate.md,
 * "Nested runs"). A swamp that passes the gate publishes the swamp-club
 * signed proof its pass rests on, prefixed with its own pid. A swamp it
 * starts, directly or through a workflow shell step, may pass the gate on
 * that proof without a credential of its own, but only while the issuing
 * process is a live ancestor running the same executable. The pass carries
 * no API key and no public key: the proof is checked only against the keys
 * the gate already trusts.
 */

import {
  base64urlDecode,
  base64urlEncode,
  type ProofPayload,
} from "./verification_proof.ts";

/** The environment variable that carries the pass to child processes. */
export const NESTED_GATE_PASS_ENV = "SWAMP_NESTED_GATE_PASS";

export interface NestedGatePass {
  /** The swamp process that passed the gate and issued this pass. */
  readonly parentPid: number;
  /** The signed proof payload, as JSON. */
  readonly proof: string;
  /** The proof's Ed25519 signature, base64url. */
  readonly signature: string;
}

const PID_PATTERN = /^[1-9][0-9]*$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Encode a pass as `<pid>.<base64url proof>.<signature>`: the signin-token
 * encoding, prefixed with the issuing pid.
 */
export function formatNestedGatePass(pass: NestedGatePass): string {
  const proofB64 = base64urlEncode(new TextEncoder().encode(pass.proof));
  return `${pass.parentPid}.${proofB64}.${pass.signature}`;
}

/**
 * Decode a pass, or return null for anything that is not exactly
 * `<positive integer pid>.<base64url>.<base64url>` with a proof that decodes
 * to JSON. Whether the proof is genuine is the gate's check, not this one.
 */
export function parseNestedGatePass(value: string): NestedGatePass | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [pidText, proofB64, signature] = parts;
  if (!PID_PATTERN.test(pidText)) return null;
  const parentPid = Number(pidText);
  if (!Number.isSafeInteger(parentPid)) return null;
  const signed = decodeSignedProof(proofB64, signature);
  return signed ? { parentPid, ...signed } : null;
}

/**
 * The pass a serve hands a worker it enrolled (design/surfaces/auth-gate.md,
 * "Remote workers"): the proof the serve's own pass rests on, with no pid.
 * The issuer is a remote process, so there is no ancestry to check; the
 * serve admitting the worker stands in for it.
 */
export interface OrchestratorGatePass {
  /** The signed proof payload, as JSON. */
  readonly proof: string;
  /** The proof's Ed25519 signature, base64url. */
  readonly signature: string;
}

/** Encode a pass as `<base64url proof>.<signature>`, as a signin token is. */
export function formatOrchestratorGatePass(
  pass: OrchestratorGatePass,
): string {
  const proofB64 = base64urlEncode(new TextEncoder().encode(pass.proof));
  return `${proofB64}.${pass.signature}`;
}

/**
 * Decode an orchestrator pass, or return null for anything that is not
 * exactly `<base64url>.<base64url>` with a proof that decodes to JSON.
 */
export function parseOrchestratorGatePass(
  value: string,
): OrchestratorGatePass | null {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  return decodeSignedProof(parts[0], parts[1]);
}

function decodeSignedProof(
  proofB64: string,
  signature: string,
): OrchestratorGatePass | null {
  if (!BASE64URL_PATTERN.test(proofB64) || !BASE64URL_PATTERN.test(signature)) {
    return null;
  }
  try {
    const proof = new TextDecoder("utf-8", { fatal: true }).decode(
      base64urlDecode(proofB64),
    );
    JSON.parse(proof);
    return { proof, signature };
  } catch {
    return null;
  }
}

/**
 * Whether a signed proof may carry a nested run under an ancestor that
 * started at `ancestorStartedAt` (Unix seconds): it must have an `exp`, and
 * must still have been valid when that ancestor started, since that is when
 * the ancestor was admitted on it. A long-running ancestor therefore keeps
 * its children passing after the proof expires, while a leaked or old proof
 * is useless under any process started after its expiry. A proof without an
 * `exp` (a signin token) never qualifies; the gate never hands one down.
 */
export function admitsNestedRun(
  payload: Pick<ProofPayload, "exp">,
  ancestorStartedAt: number,
): boolean {
  return payload.exp !== undefined && payload.exp > ancestorStartedAt;
}
