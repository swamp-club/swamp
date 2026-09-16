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

import { assertEquals } from "@std/assert";
import { AuthVerificationRepository } from "./auth_verification_repository.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("AuthVerificationRepository: save and load round-trip", async () => {
  await withTempDir(async (dir) => {
    const repo = new AuthVerificationRepository({ configDir: dir });
    await repo.save(
      '{"sub":"user-1"}',
      "sig123",
      [{ kid: "k1", key: "pubkey" }],
    );

    const loaded = await repo.load();
    assertEquals(loaded?.proof, '{"sub":"user-1"}');
    assertEquals(loaded?.signature, "sig123");
    assertEquals(loaded?.publicKeys, [{ kid: "k1", key: "pubkey" }]);
    assertEquals(typeof loaded?.cachedAt, "string");
  });
});

Deno.test("AuthVerificationRepository: load returns null when no file exists", async () => {
  await withTempDir(async (dir) => {
    const repo = new AuthVerificationRepository({
      configDir: dir,
      getSigninToken: () => undefined,
    });
    const loaded = await repo.load();
    assertEquals(loaded, null);
  });
});

Deno.test("AuthVerificationRepository: delete removes the file", async () => {
  await withTempDir(async (dir) => {
    const repo = new AuthVerificationRepository({
      configDir: dir,
      getSigninToken: () => undefined,
    });
    await repo.save('{"sub":"u"}', "sig", []);
    assertEquals((await repo.load()) !== null, true);

    await repo.delete();
    assertEquals(await repo.load(), null);
  });
});

Deno.test("AuthVerificationRepository: delete is idempotent", async () => {
  await withTempDir(async (dir) => {
    const repo = new AuthVerificationRepository({
      configDir: dir,
      getSigninToken: () => undefined,
    });
    await repo.delete();
    await repo.delete();
  });
});

Deno.test("AuthVerificationRepository: SWAMP_SIGNIN_TOKEN takes precedence over file", async () => {
  await withTempDir(async (dir) => {
    const proofJson =
      '{"sub":"from-token","fpr":"x","iat":1,"kid":"k","org":[],"scopes":[]}';
    const proofB64 = btoa(proofJson)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const repo = new AuthVerificationRepository({
      configDir: dir,
      getSigninToken: () => `${proofB64}.fakesignature`,
    });

    await repo.save('{"sub":"from-file"}', "filesig", []);
    const loaded = await repo.load();
    assertEquals(loaded?.proof, proofJson);
    assertEquals(loaded?.signature, "fakesignature");
    assertEquals(loaded?.publicKeys, []);
  });
});

Deno.test("AuthVerificationRepository: malformed SWAMP_SIGNIN_TOKEN falls through to file", async () => {
  await withTempDir(async (dir) => {
    const repo = new AuthVerificationRepository({
      configDir: dir,
      getSigninToken: () => "not-valid-token-no-dot",
    });

    await repo.save('{"sub":"from-file"}', "filesig", [{
      kid: "k",
      key: "pk",
    }]);
    const loaded = await repo.load();
    assertEquals(loaded?.proof, '{"sub":"from-file"}');
  });
});

Deno.test("AuthVerificationRepository: SWAMP_SIGNIN_TOKEN with invalid base64 falls through to file", async () => {
  await withTempDir(async (dir) => {
    const repo = new AuthVerificationRepository({
      configDir: dir,
      getSigninToken: () => "!!!invalid!!!.sig",
    });

    await repo.save('{"sub":"from-file"}', "filesig", []);
    const loaded = await repo.load();
    assertEquals(loaded?.proof, '{"sub":"from-file"}');
  });
});
