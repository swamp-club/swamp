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
import { ComponentHealthChecker } from "./component_health_checker.ts";

Deno.test("ComponentHealthChecker: returns empty array with no checks", async () => {
  const checker = new ComponentHealthChecker({});
  const results = await checker.checkAll();
  assertEquals(results, []);
});

Deno.test("ComponentHealthChecker: reports healthy datastore", async () => {
  const checker = new ComponentHealthChecker({
    checkDatastore: (_signal) =>
      Promise.resolve({
        healthy: true,
        message: "Datastore is reachable",
        latencyMs: 5,
        datastoreType: "filesystem",
      }),
  });

  const results = await checker.checkAll();
  assertEquals(results.length, 1);
  assertEquals(results[0].name, "datastore");
  assertEquals(results[0].healthy, true);
  assertEquals(results[0].latencyMs, 5);
});

Deno.test("ComponentHealthChecker: reports unhealthy datastore", async () => {
  const checker = new ComponentHealthChecker({
    checkDatastore: (_signal) =>
      Promise.resolve({
        healthy: false,
        message: "Connection refused",
        latencyMs: 1000,
        datastoreType: "s3",
      }),
  });

  const results = await checker.checkAll();
  assertEquals(results.length, 1);
  assertEquals(results[0].healthy, false);
  assertEquals(results[0].message, "Connection refused");
});

Deno.test("ComponentHealthChecker: handles check that throws", async () => {
  const checker = new ComponentHealthChecker({
    checkDatastore: (_signal) => Promise.reject(new Error("Network timeout")),
  });

  const results = await checker.checkAll();
  assertEquals(results.length, 1);
  assertEquals(results[0].healthy, false);
  assertEquals(results[0].message, "Network timeout");
});

Deno.test("ComponentHealthChecker: runs datastore and vault in parallel", async () => {
  const order: string[] = [];
  const checker = new ComponentHealthChecker({
    checkDatastore: async (_signal) => {
      order.push("datastore-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("datastore-end");
      return {
        healthy: true,
        message: "OK",
        latencyMs: 10,
        datastoreType: "filesystem",
      };
    },
    checkVault: async (_signal) => {
      order.push("vault-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("vault-end");
      return {
        healthy: true,
        message: "OK",
        latencyMs: 10,
        datastoreType: "vault",
      };
    },
  });

  const results = await checker.checkAll();
  assertEquals(results.length, 2);
  assertEquals(results[0].name, "datastore");
  assertEquals(results[1].name, "vault");
});
