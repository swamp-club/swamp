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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../domain/errors.ts";
import { createSafeMethodEnv } from "../domain/remote/environment_snapshot.ts";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";
import {
  OAUTH_CLIENT_SECRET_ENV,
  OAUTH_CLIENT_SECRET_FILE_ENV,
  resolveOAuthClientSecret,
} from "./oauth_client_secret_source.ts";

const UNSET = {
  [OAUTH_CLIENT_SECRET_ENV]: undefined,
  [OAUTH_CLIENT_SECRET_FILE_ENV]: undefined,
};

async function withSecretDir(fn: (dir: string) => void): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((err) => {
      if (Deno.build.os !== "windows") throw err;
    });
  }
}

Deno.test("resolveOAuthClientSecret: returns undefined when no source is set", () => {
  withMockedEnv(UNSET, () => {
    assertEquals(resolveOAuthClientSecret(undefined), undefined);
  });
});

Deno.test("resolveOAuthClientSecret: reads the plain env var, trimmed", () => {
  withMockedEnv(
    { ...UNSET, [OAUTH_CLIENT_SECRET_ENV]: " env-secret\n" },
    () => {
      assertEquals(resolveOAuthClientSecret(undefined), "env-secret");
    },
  );
});

Deno.test("resolveOAuthClientSecret: reads the file the env var names, trimmed", async () => {
  await withSecretDir((dir) => {
    const path = join(dir, "secret");
    Deno.writeTextFileSync(path, "file-secret\n");
    withMockedEnv({ ...UNSET, [OAUTH_CLIENT_SECRET_FILE_ENV]: path }, () => {
      assertEquals(resolveOAuthClientSecret(undefined), "file-secret");
    });
  });
});

Deno.test("resolveOAuthClientSecret: the flag wins over both env vars", async () => {
  await withSecretDir((dir) => {
    const path = join(dir, "secret");
    Deno.writeTextFileSync(path, "flag-secret");
    withMockedEnv({
      [OAUTH_CLIENT_SECRET_ENV]: "env-secret",
      [OAUTH_CLIENT_SECRET_FILE_ENV]: join(dir, "missing"),
    }, () => {
      assertEquals(resolveOAuthClientSecret(path), "flag-secret");
    });
  });
});

Deno.test("resolveOAuthClientSecret: both env vars set together is an error", () => {
  withMockedEnv({
    [OAUTH_CLIENT_SECRET_ENV]: "env-secret",
    [OAUTH_CLIENT_SECRET_FILE_ENV]: "/some/path",
  }, () => {
    assertThrows(
      () => resolveOAuthClientSecret(undefined),
      UserError,
      "mutually exclusive",
    );
  });
});

Deno.test("resolveOAuthClientSecret: a missing or empty file is refused without echoing a value", async () => {
  await withSecretDir((dir) => {
    const empty = join(dir, "empty");
    Deno.writeTextFileSync(empty, "  \n");
    withMockedEnv(UNSET, () => {
      assertThrows(
        () => resolveOAuthClientSecret(join(dir, "missing")),
        UserError,
        "--oauth-client-secret-file file not found",
      );
      assertThrows(
        () => resolveOAuthClientSecret(empty),
        UserError,
        "--oauth-client-secret-file file is empty",
      );
      // Windows reports reading a directory as access denied, not EISDIR.
      const dirError = assertThrows(
        () => resolveOAuthClientSecret(dir),
        UserError,
      );
      assert(
        dirError.message.includes("is a directory") ||
          dirError.message.includes("not readable"),
        dirError.message,
      );
    });
  });
});

Deno.test("resolveOAuthClientSecret: method subprocesses never inherit the secret variables", () => {
  const safe = createSafeMethodEnv({
    [OAUTH_CLIENT_SECRET_ENV]: "secret",
    [OAUTH_CLIENT_SECRET_FILE_ENV]: "/run/secrets/oauth",
    SWAMP_OAUTH_CLIENT_ID: "client-id",
    KEEP: "kept",
  });
  assertEquals(safe, { KEEP: "kept" });
});
