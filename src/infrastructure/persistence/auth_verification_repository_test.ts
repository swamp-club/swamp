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
import { join } from "@std/path";
import { withMockedEnv } from "./path_test_helpers.ts";
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

Deno.test("AuthVerificationRepository: loadCandidates returns the token and the file proof, token first", async () => {
  await withTempDir(async (dir) => {
    const proofJson =
      '{"sub":"from-token","fpr":"x","iat":1,"kid":"k","org":[],"scopes":[]}';
    const proofB64 = btoa(proofJson)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const repo = new AuthVerificationRepository({
      configDir: dir,
      getSigninToken: () => `${proofB64}.tokensig`,
    });
    await repo.save('{"sub":"from-file"}', "filesig", []);

    const candidates = await repo.loadCandidates();
    assertEquals(candidates.map((c) => c.source), ["signin_token", "file"]);
    assertEquals(candidates[0].verification.proof, proofJson);
    assertEquals(candidates[1].verification.signature, "filesig");
  });
});

Deno.test("AuthVerificationRepository: loadCandidates is empty with neither proof", async () => {
  await withTempDir(async (dir) => {
    const repo = new AuthVerificationRepository({
      configDir: dir,
      getSigninToken: () => undefined,
    });
    assertEquals(await repo.loadCandidates(), []);
  });
});

Deno.test("AuthVerificationRepository: the fail-open stamp marks, reads and clears", async () => {
  await withTempDir(async (dir) => {
    const repo = new AuthVerificationRepository({ configDir: dir });
    assertEquals(await repo.readFailOpenSince(), undefined);
    await repo.markFailOpenSince(1_800_000_000);
    assertEquals(await repo.readFailOpenSince(), 1_800_000_000);
    await repo.markFailOpenSince(1_800_000_500);
    assertEquals(await repo.readFailOpenSince(), 1_800_000_500);
    await repo.clearFailOpen();
    assertEquals(await repo.readFailOpenSince(), undefined);
    await repo.clearFailOpen();
  });
});

Deno.test("AuthVerificationRepository: a malformed fail-open stamp reads as absent", async () => {
  await withTempDir(async (dir) => {
    const repo = new AuthVerificationRepository({ configDir: dir });
    for (
      const text of [
        "not json",
        '{"since":"yesterday"}',
        '{"since":null}',
        "[]",
        '{"since":1e400}',
      ]
    ) {
      await Deno.writeTextFile(join(dir, "auth_fail_open.json"), text);
      assertEquals(await repo.readFailOpenSince(), undefined, text);
    }
  });
});

Deno.test("AuthVerificationRepository: a token check is remembered per fingerprint", async () => {
  await withTempDir(async (dir) => {
    const repo = new AuthVerificationRepository({ configDir: dir });
    assertEquals(await repo.readTokenCheck("fpr-a"), undefined);
    await repo.recordTokenCheck("fpr-a", 1_800_000_000);
    assertEquals(await repo.readTokenCheck("fpr-a"), 1_800_000_000);
    assertEquals(await repo.readTokenCheck("fpr-b"), undefined);
    await repo.clearTokenCheck();
    assertEquals(await repo.readTokenCheck("fpr-a"), undefined);
  });
});

Deno.test("AuthVerificationRepository: stamp files are written owner-only", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (dir) => {
    const repo = new AuthVerificationRepository({ configDir: dir });
    await repo.markFailOpenSince(1);
    await repo.recordTokenCheck("f", 1);
    for (const file of ["auth_fail_open.json", "auth_token_check.json"]) {
      const info = await Deno.stat(join(dir, file));
      assertEquals((info.mode ?? 0) & 0o777, 0o600, file);
    }
  });
});

Deno.test("AuthVerificationRepository: a signin token borrows the public keys cached with the file proof", async () => {
  await withTempDir(async (dir) => {
    const proofB64 = btoa(
      '{"sub":"t","fpr":"x","iat":1,"kid":"k2","org":[],"scopes":[]}',
    )
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const repo = new AuthVerificationRepository({
      configDir: dir,
      getSigninToken: () => `${proofB64}.sig`,
    });
    assertEquals(
      (await repo.loadCandidates())[0].verification.publicKeys,
      [],
    );
    await repo.save("{}", "s", [{ kid: "k2", key: "pk2" }]);
    assertEquals(
      (await repo.loadCandidates())[0].verification.publicKeys,
      [{ kid: "k2", key: "pk2" }],
    );
  });
});

Deno.test("AuthVerificationRepository: with no config dir, a signin token still loads and reads report nothing cached", async () => {
  const proofB64 = btoa(
    '{"sub":"t","fpr":"x","iat":1,"kid":"k","org":[],"scopes":[]}',
  )
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await withMockedEnv({
    SWAMP_CONFIG_DIR: undefined,
    SWAMP_HOME: undefined,
    XDG_CONFIG_HOME: undefined,
    HOME: undefined,
    USERPROFILE: undefined,
  }, async () => {
    const repo = new AuthVerificationRepository({
      getSigninToken: () => `${proofB64}.sig`,
    });
    const candidates = await repo.loadCandidates();
    assertEquals(candidates.map((c) => c.source), ["signin_token"]);
    assertEquals(await repo.readFailOpenSince(), undefined);
    assertEquals(await repo.readTokenCheck("x"), undefined);
  });
});
