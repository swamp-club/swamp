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
 * a nested swamp may pass on the parent's signed proof without a credential,
 * only while the issuing process is a live ancestor running the same
 * executable; the pass carries no API key or public key
 */

import {
  base64urlDecode,
  base64urlEncode,
  type ProofPayload,
} from "./verification_proof.ts";

export const NESTED_GATE_PASS_ENV = "SWAMP_NESTED_GATE_PASS";

export interface NestedGatePass {
  readonly parentPid: number;
  readonly proof: string;
  readonly signature: string;
}

const PID_PATTERN = /^[1-9][0-9]*$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function formatNestedGatePass(pass: NestedGatePass): string {
  const proofB64 = base64urlEncode(new TextEncoder().encode(pass.proof));
  return `${pass.parentPid}.${proofB64}.${pass.signature}`;
}

/** whether the proof is genuine is the gate's check, not this one */
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
 * the issuer is a remote process, so there is no ancestry to check; the serve
 * admitting the worker stands in for it
 */
export interface OrchestratorGatePass {
  readonly proof: string;
  readonly signature: string;
}

export function formatOrchestratorGatePass(
  pass: OrchestratorGatePass,
): string {
  const proofB64 = base64urlEncode(new TextEncoder().encode(pass.proof));
  return `${proofB64}.${pass.signature}`;
}

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
 * the proof must have an exp and still be valid when the ancestor started, so a
 * long-running ancestor keeps children passing but an old or leaked proof is
 * useless; a signin token is never handed down
 */
export function admitsNestedRun(
  payload: Pick<ProofPayload, "exp">,
  ancestorStartedAt: number,
): boolean {
  return payload.exp !== undefined && payload.exp > ancestorStartedAt;
}
