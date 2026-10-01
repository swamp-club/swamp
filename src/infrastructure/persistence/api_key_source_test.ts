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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import {
  apiKeySourceName,
  hasApiKeySource,
  resolveApiKey,
  setApiKeyFileOverride,
} from "./api_key_source.ts";
import { withMockedEnv } from "./path_test_helpers.ts";

const UNSET = {
  SWAMP_API_KEY: undefined,
  SWAMP_API_KEY_FILE: undefined,
};

async function withKeyDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    setApiKeyFileOverride(undefined);
    await Deno.remove(dir, { recursive: true }).catch((err) => {
      if (Deno.build.os !== "windows") throw err;
    });
  }
}

Deno.test("resolveApiKey: returns undefined when no source is set", () => {
  withMockedEnv(UNSET, () => {
    assertEquals(resolveApiKey(), undefined);
    assertEquals(hasApiKeySource(), false);
    assertEquals(apiKeySourceName(), undefined);
  });
});

Deno.test("resolveApiKey: treats empty env values as unset", () => {
  withMockedEnv({ SWAMP_API_KEY: "", SWAMP_API_KEY_FILE: "" }, () => {
    assertEquals(resolveApiKey(), undefined);
    assertEquals(hasApiKeySource(), false);
  });
});

Deno.test("resolveApiKey: reads SWAMP_API_KEY", () => {
  withMockedEnv({ ...UNSET, SWAMP_API_KEY: "swamp_org_env" }, () => {
    assertEquals(resolveApiKey(), "swamp_org_env");
    assertEquals(apiKeySourceName(), "SWAMP_API_KEY");
  });
});

Deno.test("resolveApiKey: reads the SWAMP_API_KEY_FILE file and strips one trailing newline", async () => {
  await withKeyDir(async (dir) => {
    const path = join(dir, "key");
    await Deno.writeTextFile(path, "swamp_org_file\n");
    withMockedEnv({ ...UNSET, SWAMP_API_KEY_FILE: path }, () => {
      assertEquals(resolveApiKey(), "swamp_org_file");
      assertEquals(apiKeySourceName(), "SWAMP_API_KEY_FILE");
    });
  });
});

Deno.test("resolveApiKey: strips a trailing CRLF from the key file", async () => {
  await withKeyDir(async (dir) => {
    const path = join(dir, "key");
    await Deno.writeTextFile(path, "swamp_org_crlf\r\n");
    withMockedEnv({ ...UNSET, SWAMP_API_KEY_FILE: path }, () => {
      assertEquals(resolveApiKey(), "swamp_org_crlf");
    });
  });
});

Deno.test("resolveApiKey: re-reads the key file on every call", async () => {
  await withKeyDir(async (dir) => {
    const path = join(dir, "key");
    await Deno.writeTextFile(path, "swamp_org_old");
    await withMockedEnv({ ...UNSET, SWAMP_API_KEY_FILE: path }, async () => {
      assertEquals(resolveApiKey(), "swamp_org_old");
      await Deno.writeTextFile(path, "swamp_org_new");
      assertEquals(resolveApiKey(), "swamp_org_new");
    });
  });
});

Deno.test("resolveApiKey: refuses SWAMP_API_KEY and SWAMP_API_KEY_FILE together", async () => {
  await withKeyDir(async (dir) => {
    const path = join(dir, "key");
    await Deno.writeTextFile(path, "swamp_org_file");
    withMockedEnv(
      { SWAMP_API_KEY: "swamp_org_env", SWAMP_API_KEY_FILE: path },
      () => {
        const err = assertThrows(() => resolveApiKey(), UserError);
        assertStringIncludes(err.message, "mutually exclusive");
        // Naming the source never throws, so commands that need no key run.
        assertEquals(hasApiKeySource(), true);
      },
    );
  });
});

Deno.test("resolveApiKey: the --club-api-key-file override wins over both env vars", async () => {
  await withKeyDir(async (dir) => {
    const path = join(dir, "flag-key");
    await Deno.writeTextFile(path, "swamp_org_flag\n");
    setApiKeyFileOverride(path);
    withMockedEnv(
      { SWAMP_API_KEY: "swamp_org_env", SWAMP_API_KEY_FILE: join(dir, "x") },
      () => {
        assertEquals(resolveApiKey(), "swamp_org_flag");
        assertEquals(apiKeySourceName(), "--club-api-key-file");
      },
    );
  });
});

Deno.test("resolveApiKey: a missing key file is a UserError naming the source and path", async () => {
  await withKeyDir((dir) => {
    const path = join(dir, "missing");
    withMockedEnv({ ...UNSET, SWAMP_API_KEY_FILE: path }, () => {
      const err = assertThrows(() => resolveApiKey(), UserError);
      assertStringIncludes(err.message, "SWAMP_API_KEY_FILE file not found");
      assertStringIncludes(err.message, path);
    });
    return Promise.resolve();
  });
});

Deno.test("resolveApiKey: a missing --club-api-key-file names the flag", async () => {
  await withKeyDir((dir) => {
    const path = join(dir, "missing");
    setApiKeyFileOverride(path);
    withMockedEnv(UNSET, () => {
      const err = assertThrows(() => resolveApiKey(), UserError);
      assertStringIncludes(err.message, "--club-api-key-file file not found");
    });
    return Promise.resolve();
  });
});

Deno.test("resolveApiKey: an empty key file is a UserError", async () => {
  await withKeyDir(async (dir) => {
    const path = join(dir, "empty");
    await Deno.writeTextFile(path, "\n");
    withMockedEnv({ ...UNSET, SWAMP_API_KEY_FILE: path }, () => {
      const err = assertThrows(() => resolveApiKey(), UserError);
      assertStringIncludes(err.message, "SWAMP_API_KEY_FILE file is empty");
    });
  });
});

Deno.test({
  name: "resolveApiKey: a directory path is a UserError",
  // Windows reports a directory read as a different error class; the
  // directory hint is for the Linux container secret mounts it guards.
  ignore: Deno.build.os === "windows",
}, async () => {
  await withKeyDir((dir) => {
    withMockedEnv({ ...UNSET, SWAMP_API_KEY_FILE: dir }, () => {
      const err = assertThrows(() => resolveApiKey(), UserError);
      assertStringIncludes(err.message, "SWAMP_API_KEY_FILE");
      assertStringIncludes(err.message, dir);
    });
    return Promise.resolve();
  });
});

Deno.test("hasApiKeySource: reads no file, so a missing key file still counts as set", async () => {
  await withKeyDir((dir) => {
    withMockedEnv(
      { ...UNSET, SWAMP_API_KEY_FILE: join(dir, "missing") },
      () => {
        assertEquals(hasApiKeySource(), true);
        assertEquals(apiKeySourceName(), "SWAMP_API_KEY_FILE");
      },
    );
    return Promise.resolve();
  });
});
