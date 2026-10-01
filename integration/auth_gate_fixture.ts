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

// A throwaway swamp-club credential for CLI children spawned by the legacy
// subprocess tests, so they pass the auth gate without a network call and
// without any switch in the product. The proof is signed by a per-run test
// key cached alongside it, exactly as a real whoami would have left it.

import { join } from "@std/path";
import {
  generateTestSigningKey,
  mintTestProof,
} from "../src/domain/auth/proof_test_helpers.ts";

export const GATE_FIXTURE_API_KEY = "swamp_integration_fixture_key";

/** Credential sources that would override the fixture in a child. */
const CREDENTIAL_ENV = [
  "SWAMP_API_KEY",
  "SWAMP_API_KEY_FILE",
  "SWAMP_SIGNIN_TOKEN",
  "SWAMP_CLUB_URL",
];

/**
 * Write a logged-in credential and a valid proof for it into `configDir`
 * (a swamp config dir, i.e. what SWAMP_CONFIG_DIR or
 * `<XDG_CONFIG_HOME>/swamp` names).
 */
export async function writeGateCredential(configDir: string): Promise<void> {
  await Deno.mkdir(configDir, { recursive: true });
  await Deno.writeTextFile(
    join(configDir, "auth.json"),
    JSON.stringify({
      serverUrl: "https://swamp-club.com",
      apiKey: GATE_FIXTURE_API_KEY,
      apiKeyId: "integration-fixture",
      username: "integration-fixture",
    }),
  );
  const now = Math.floor(Date.now() / 1000);
  const minted = await mintTestProof(
    await generateTestSigningKey(),
    GATE_FIXTURE_API_KEY,
    { iat: now, exp: now + 14 * 86_400 },
  );
  await Deno.writeTextFile(
    join(configDir, "auth_verified.json"),
    JSON.stringify({ ...minted, cachedAt: new Date().toISOString() }),
  );
}

/** `env` with every credential source that could shadow the fixture removed. */
export function withoutCredentialEnv(
  env: Record<string, string>,
): Record<string, string> {
  const copy = { ...env };
  for (const key of CREDENTIAL_ENV) delete copy[key];
  return copy;
}

/**
 * Run `fn` with the environment for a CLI child that passes the gate: this
 * process's env, minus credential sources, plus a fresh SWAMP_CONFIG_DIR
 * holding the fixture. Spawn with `clearEnv: true` so nothing else leaks in.
 * The config dir is removed afterwards.
 */
export async function withGateCredentialEnv<T>(
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const configDir = await Deno.makeTempDir({ prefix: "swamp-gate-fixture-" });
  try {
    await writeGateCredential(configDir);
    return await fn({
      ...withoutCredentialEnv(Deno.env.toObject()),
      SWAMP_CONFIG_DIR: configDir,
    });
  } finally {
    await Deno.remove(configDir, { recursive: true }).catch(() => {});
  }
}
