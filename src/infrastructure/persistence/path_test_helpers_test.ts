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

import { runOutsideAmbientContext } from "../runtime/ambient_context.ts";
import {
  assertEquals,
  AssertionError,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { assertPathEquals, withMockedEnv } from "./path_test_helpers.ts";

Deno.test("assertPathEquals: forward-slash paths compare equal", () => {
  assertPathEquals("/repo/foo/bar", "/repo/foo/bar");
});

Deno.test("assertPathEquals: backslash actual matches forward-slash expected", () => {
  assertPathEquals("\\repo\\foo\\bar", "/repo/foo/bar");
});

Deno.test("assertPathEquals: forward-slash actual matches backslash expected", () => {
  assertPathEquals("/repo/foo/bar", "\\repo\\foo\\bar");
});

Deno.test("assertPathEquals: mixed separators normalize to equal", () => {
  assertPathEquals("/repo\\foo/bar", "\\repo/foo\\bar");
});

Deno.test("assertPathEquals: genuinely different paths still throw", () => {
  assertThrows(
    () => assertPathEquals("/repo/foo", "/repo/bar"),
    AssertionError,
  );
});

Deno.test("assertPathEquals: optional message is forwarded", () => {
  const err = assertThrows(
    () => assertPathEquals("a", "b", "custom-msg"),
    AssertionError,
  );
  if (!err.message.includes("custom-msg")) {
    throw new Error(
      `expected message to include 'custom-msg', got: ${err.message}`,
    );
  }
});

// A variable taken from the real environment, with the exact key spelling
// `toObject` reports (Windows spells PATH as `Path`), so the tests need no
// real env write and hold on every platform.
function realEnvEntry(): [string, string] {
  const entry = Object.entries(Deno.env.toObject())[0];
  if (!entry) throw new Error("test needs at least one real env variable");
  return entry;
}

function uniqueEnvName(): string {
  return `SWAMP_MOCKED_ENV_${crypto.randomUUID().replaceAll("-", "_")}`;
}

Deno.test("withMockedEnv: get, has and toObject answer from overrides", () => {
  const name = uniqueEnvName();
  withMockedEnv({ [name]: "mocked" }, () => {
    assertEquals(Deno.env.get(name), "mocked");
    assertEquals(Deno.env.has(name), true);
    assertEquals(Deno.env.toObject()[name], "mocked");
  });
});

Deno.test("withMockedEnv: undefined hides a real variable from every reader", () => {
  const [key] = realEnvEntry();
  withMockedEnv({ [key]: undefined }, () => {
    assertEquals(Deno.env.get(key), undefined);
    assertEquals(Deno.env.has(key), false);
    assertEquals(Object.hasOwn(Deno.env.toObject(), key), false);
  });
});

Deno.test("withMockedEnv: keys not overridden pass through to the real environment", () => {
  const [key, value] = realEnvEntry();
  const name = uniqueEnvName();
  const real = Deno.env.toObject();
  withMockedEnv({ [name]: "x" }, () => {
    assertEquals(Deno.env.get(key), value);
    assertEquals(Deno.env.has(key), true);
    assertEquals(Deno.env.toObject(), { ...real, [name]: "x" });
  });
});

Deno.test("withMockedEnv: once fn throws, every reader answers from the real env", () => {
  const name = uniqueEnvName();
  assertThrows(
    () =>
      withMockedEnv({ [name]: "mocked" }, () => {
        throw new Error("boom");
      }),
    Error,
    "boom",
  );
  assertEquals(Deno.env.get(name), undefined);
  assertEquals(Deno.env.has(name), false);
  assertEquals(Object.hasOwn(Deno.env.toObject(), name), false);
});

Deno.test("withMockedEnv: once an async fn rejects, every reader answers from the real env", async () => {
  const name = uniqueEnvName();
  await assertRejects(
    () =>
      withMockedEnv({ [name]: "mocked" }, async () => {
        await Promise.resolve();
        assertEquals(Deno.env.get(name), "mocked");
        throw new Error("boom");
      }),
    Error,
    "boom",
  );
  assertEquals(Deno.env.get(name), undefined);
  assertEquals(Deno.env.has(name), false);
  assertEquals(Object.hasOwn(Deno.env.toObject(), name), false);
});

Deno.test("withMockedEnv: a nested call layers over the enclosing one", () => {
  const outer = uniqueEnvName();
  const inner = uniqueEnvName();
  withMockedEnv({ [outer]: "outer", [inner]: "outer" }, () => {
    withMockedEnv({ [inner]: "inner" }, () => {
      assertEquals(Deno.env.get(outer), "outer");
      assertEquals(Deno.env.get(inner), "inner");
    });
    assertEquals(Deno.env.get(inner), "outer");
  });
});

Deno.test("withMockedEnv: code running alongside, outside fn, reads the real env", async () => {
  const name = uniqueEnvName();
  const mockedReading = Promise.withResolvers<void>();
  const outsideRead = Promise.withResolvers<void>();
  const mocked = withMockedEnv({ [name]: "mocked" }, async () => {
    mockedReading.resolve();
    await outsideRead.promise;
    return Deno.env.get(name);
  });
  await mockedReading.promise;
  assertEquals(Deno.env.get(name), undefined);
  assertEquals(Deno.env.has(name), false);
  outsideRead.resolve();
  assertEquals(await mocked, "mocked");
});

Deno.test("withMockedEnv: an ambient reset inside fn still reads the overrides", () => {
  const name = uniqueEnvName();
  const seen = withMockedEnv(
    { [name]: "mocked" },
    () => runOutsideAmbientContext(() => Deno.env.get(name)),
  );
  assertEquals(seen, "mocked");
});
