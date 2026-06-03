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
import {
  type CustomDatastoreConfig,
  DEFAULT_SYNC_TIMEOUT_MS,
  type FilesystemDatastoreConfig,
  resolveSyncTimeoutMs,
  SYNC_TIMEOUT_ENV_VAR,
} from "./datastore_config.ts";

const filesystemConfig: FilesystemDatastoreConfig = {
  type: "filesystem",
  path: "/tmp/ds",
};

const customConfig: CustomDatastoreConfig = {
  type: "s3",
  config: {},
  datastorePath: "/tmp/ds",
  cachePath: "/tmp/cache",
};

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prior = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
  try {
    return fn();
  } finally {
    if (prior === undefined) Deno.env.delete(key);
    else Deno.env.set(key, prior);
  }
}

Deno.test("resolveSyncTimeoutMs: override wins over config, env, and default", () => {
  const configured: CustomDatastoreConfig = {
    ...customConfig,
    syncTimeoutMs: 60_000,
  };
  withEnv(SYNC_TIMEOUT_ENV_VAR, "120000", () => {
    assertEquals(resolveSyncTimeoutMs(configured, 30_000), 30_000);
  });
});

Deno.test("resolveSyncTimeoutMs: override works on filesystem config too", () => {
  withEnv(SYNC_TIMEOUT_ENV_VAR, undefined, () => {
    assertEquals(resolveSyncTimeoutMs(filesystemConfig, 45_000), 45_000);
  });
});

Deno.test("resolveSyncTimeoutMs: non-positive override falls through", () => {
  // The CLI boundary rejects <= 0 with a UserError (see parseTimeoutFlag),
  // but if an out-of-band caller passes 0 or negative, we must not treat it
  // as a valid override — fall through to the next source.
  withEnv(SYNC_TIMEOUT_ENV_VAR, undefined, () => {
    assertEquals(
      resolveSyncTimeoutMs(customConfig, 0),
      DEFAULT_SYNC_TIMEOUT_MS,
    );
    assertEquals(
      resolveSyncTimeoutMs(customConfig, -1),
      DEFAULT_SYNC_TIMEOUT_MS,
    );
  });
});

Deno.test("resolveSyncTimeoutMs: undefined override preserves existing precedence (config)", () => {
  const configured: CustomDatastoreConfig = {
    ...customConfig,
    syncTimeoutMs: 42_000,
  };
  withEnv(SYNC_TIMEOUT_ENV_VAR, undefined, () => {
    assertEquals(resolveSyncTimeoutMs(configured, undefined), 42_000);
  });
});

Deno.test("resolveSyncTimeoutMs: undefined override preserves existing precedence (env)", () => {
  withEnv(SYNC_TIMEOUT_ENV_VAR, "180000", () => {
    assertEquals(resolveSyncTimeoutMs(customConfig, undefined), 180_000);
  });
});

Deno.test("resolveSyncTimeoutMs: no override, no config, no env returns default", () => {
  withEnv(SYNC_TIMEOUT_ENV_VAR, undefined, () => {
    assertEquals(resolveSyncTimeoutMs(customConfig), DEFAULT_SYNC_TIMEOUT_MS);
  });
});
