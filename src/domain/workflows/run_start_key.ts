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

import { z } from "zod";
import { canonicalJson } from "../expressions/expression_references.ts";

export const RunStartKeyDataSchema = z.object({
  lookup: z.string().min(1),
  salt: z.string().min(1),
  fingerprint: z.string().min(1),
});

export type RunStartKeyData = z.infer<typeof RunStartKeyDataSchema>;

export interface RunStartIdentity {
  readonly workflowId: string;
  readonly principal: string;
  readonly client: string | undefined;
  readonly key: string;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(text: string): Promise<string> {
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
}

/** the key is hashed so a run record never holds a caller's key */
export function runStartLookup(identity: RunStartIdentity): Promise<string> {
  return sha256Hex(JSON.stringify([
    identity.workflowId,
    identity.principal,
    identity.client ?? "",
    identity.key,
  ]));
}

const FINGERPRINT_ITERATIONS = 100_000;

// a run's record masks a sensitive input, and this sits beside it: slow and
// salted, this only raises the price of guessing a low-entropy one
async function inputsFingerprint(
  inputs: Readonly<Record<string, unknown>>,
  salt: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(canonicalJson(inputs)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: FINGERPRINT_ITERATIONS,
    },
    key,
    256,
  );
  return hex(bits);
}

/** one intended start of a workflow, so a retry is told from a new start */
export class RunStartKey {
  private constructor(readonly data: RunStartKeyData) {}

  static async create(
    identity: RunStartIdentity,
    inputs: Readonly<Record<string, unknown>>,
  ): Promise<RunStartKey> {
    const salt = crypto.randomUUID();
    return new RunStartKey({
      lookup: await runStartLookup(identity),
      salt,
      fingerprint: await inputsFingerprint(inputs, salt),
    });
  }

  static fromData(data: RunStartKeyData): RunStartKey {
    return new RunStartKey(RunStartKeyDataSchema.parse(data));
  }

  get lookup(): string {
    return this.data.lookup;
  }

  async sameInputs(
    inputs: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    return this.data.fingerprint ===
      await inputsFingerprint(inputs, this.data.salt);
  }
}
