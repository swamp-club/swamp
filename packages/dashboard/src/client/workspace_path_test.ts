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
  dashboardBaseFor,
  forgetLocalToken,
  keepLocalToken,
  LOCAL_TOKEN_KEY,
  localSocketProtocols,
  localToken,
  PAGE_WORKSPACE,
  serverPath,
  serverPathFor,
  type TokenStores,
  withLocalToken,
  workspaceFromPath,
} from "./workspace_path.ts";

Deno.test("workspaceFromPath: serve's dashboard paths have no workspace", () => {
  for (
    const path of [
      "/dashboard",
      "/dashboard/",
      "/dashboard/workflows/w",
      "/dashboard/start",
      "/dashboard/w",
      "/dashboard/wx/a",
    ]
  ) {
    assertEquals(workspaceFromPath(path), null, path);
  }
});

Deno.test("workspaceFromPath: reads the local dashboard's workspace segment", () => {
  assertEquals(workspaceFromPath("/dashboard/w/misty-heron"), "misty-heron");
  assertEquals(workspaceFromPath("/dashboard/w/misty-heron/"), "misty-heron");
  assertEquals(
    workspaceFromPath("/dashboard/w/misty-heron/workflows/x/runs/1"),
    "misty-heron",
  );
  assertEquals(workspaceFromPath("/dashboard/w/%ZZ"), null);
});

Deno.test("serverPathFor and dashboardBaseFor: unchanged for serve, prefixed for a workspace", () => {
  assertEquals(serverPathFor(null, "/auth/info"), "/auth/info");
  assertEquals(serverPathFor(null, "/"), "/");
  assertEquals(
    serverPathFor("misty-heron", "/auth/info"),
    "/w/misty-heron/auth/info",
  );
  assertEquals(serverPathFor("misty-heron", "/"), "/w/misty-heron/");
  assertEquals(dashboardBaseFor(null), "/dashboard");
  assertEquals(dashboardBaseFor("misty-heron"), "/dashboard/w/misty-heron");
});

Deno.test("serverPath: with no page location (serve's tests), paths are unchanged", () => {
  assertEquals(PAGE_WORKSPACE, null);
  assertEquals(serverPath("/api/v1/health"), "/api/v1/health");
});

Deno.test("local token helpers: under serve (no workspace) nothing is added", () => {
  assertEquals(localToken(), null);
  assertEquals(withLocalToken({ a: "b" }), { a: "b" });
  assertEquals(withLocalToken(), {});
  assertEquals(localSocketProtocols(), undefined);
});

class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  get length(): number {
    return this.#items.size;
  }
  clear(): void {
    this.#items.clear();
  }
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

function memoryStores(): TokenStores & {
  sessionStore: MemoryStorage;
  localStore: MemoryStorage;
} {
  const sessionStore = new MemoryStorage();
  const localStore = new MemoryStorage();
  return {
    sessionStore,
    localStore,
    session: () => sessionStore,
    local: () => localStore,
  };
}

Deno.test("keepLocalToken: keeps the token for this tab and for other tabs", () => {
  const stores = memoryStores();
  keepLocalToken("tok-1", stores);
  assertEquals(stores.sessionStore.getItem("swamp-start-token"), "tok-1");
  assertEquals(stores.localStore.getItem(LOCAL_TOKEN_KEY), "tok-1");
});

Deno.test("keepLocalToken: blocked storage is not an error", () => {
  keepLocalToken("tok-1", {
    session: () => {
      throw new Error("blocked");
    },
    local: () => {
      throw new Error("blocked");
    },
  });
});

Deno.test("forgetLocalToken: drops the refused token from both stores", () => {
  const stores = memoryStores();
  keepLocalToken("tok-1", stores);
  forgetLocalToken("tok-1", stores);
  assertEquals(stores.sessionStore.getItem("swamp-start-token"), null);
  assertEquals(stores.localStore.getItem(LOCAL_TOKEN_KEY), null);
});

Deno.test("forgetLocalToken: leaves another swamp start's token for other tabs", () => {
  const stores = memoryStores();
  stores.sessionStore.setItem("swamp-start-token", "tok-old");
  stores.localStore.setItem(LOCAL_TOKEN_KEY, "tok-new");
  forgetLocalToken("tok-old", stores);
  assertEquals(stores.sessionStore.getItem("swamp-start-token"), null);
  assertEquals(stores.localStore.getItem(LOCAL_TOKEN_KEY), "tok-new");
});
