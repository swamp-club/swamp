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
import { withMockedEnv } from "../../persistence/path_test_helpers.ts";
import { UserError } from "../../../domain/errors.ts";
import type { V3ReplicaTarget } from "../../../domain/datastore/replica_target.ts";
import { V3_REPLICA_ENV } from "./replica_setting.ts";
import {
  replicaSettingFromTarget,
  resolveV3ReplicaPaths,
  resolveV3ReplicaSetting,
} from "./replica_target_resolver.ts";
import type { ReplicaPathStore } from "../../../domain/datastore/replica_path_store.ts";

const UNSET = { [V3_REPLICA_ENV]: undefined };

Deno.test("replicaSettingFromTarget: an s3 target replicates under its prefix", () => {
  assertEquals(
    replicaSettingFromTarget({
      type: "s3",
      bucket: "b",
      prefix: "team/root",
      region: "eu-west-1",
    }),
    { type: "s3", bucket: "b", path: "team/root", region: "eu-west-1" },
  );
});

Deno.test("replicaSettingFromTarget: an s3-compatible target keeps its endpoint and path style", () => {
  for (const forcePathStyle of [true, false]) {
    assertEquals(
      replicaSettingFromTarget({
        type: "s3",
        bucket: "b",
        prefix: "",
        endpoint: "http://127.0.0.1:9000",
        forcePathStyle,
      }),
      {
        type: "s3",
        bucket: "b",
        path: "",
        endpoint: "http://127.0.0.1:9000",
        forcePathStyle,
      },
    );
  }
});

Deno.test("replicaSettingFromTarget: a gcs target replicates under its prefix", () => {
  assertEquals(
    replicaSettingFromTarget({ type: "gcs", bucket: "g", prefix: "root" }),
    { type: "gcs", bucket: "g", path: "root" },
  );
});

Deno.test("resolveV3ReplicaSetting: the internal setting wins over the provider", () => {
  let called = false;
  withMockedEnv(
    { [V3_REPLICA_ENV]: JSON.stringify({ type: "file", path: "/r" }) },
    () => {
      assertEquals(
        resolveV3ReplicaSetting({
          replicaTarget: () => {
            called = true;
            return { type: "gcs", bucket: "g", prefix: "" };
          },
        }, "@test/ds"),
        { type: "file", path: "/r" },
      );
    },
  );
  assertEquals(called, false);
});

Deno.test("resolveV3ReplicaSetting: uses the provider's target when the setting is unset", () => {
  withMockedEnv(UNSET, () => {
    assertEquals(
      resolveV3ReplicaSetting(
        { replicaTarget: () => ({ type: "s3", bucket: "b", prefix: "p" }) },
        "@test/ds",
      ),
      { type: "s3", bucket: "b", path: "p" },
    );
  });
});

Deno.test("resolveV3ReplicaSetting: a provider without replicaTarget cannot host v3", () => {
  withMockedEnv(UNSET, () => {
    const error = assertThrows(
      () => resolveV3ReplicaSetting({}, "@test/ds"),
      UserError,
    );
    assertStringIncludes(error.message, "@test/ds");
    assertStringIncludes(error.message, "replicaTarget()");
  });
});

Deno.test("resolveV3ReplicaSetting: a provider's own refusal becomes a UserError naming it", () => {
  withMockedEnv(UNSET, () => {
    const error = assertThrows(
      () =>
        resolveV3ReplicaSetting({
          replicaTarget: () => {
            throw new Error(
              "a custom apiEndpoint has no Litestream equivalent",
            );
          },
        }, "@swamp/gcs-datastore"),
      UserError,
    );
    assertStringIncludes(error.message, "@swamp/gcs-datastore");
    assertStringIncludes(error.message, "custom apiEndpoint");
  });
});

Deno.test("resolveV3ReplicaSetting: refuses a target carrying credentials", () => {
  withMockedEnv(UNSET, () => {
    const error = assertThrows(
      () =>
        resolveV3ReplicaSetting({
          replicaTarget: () =>
            ({
              type: "s3",
              bucket: "b",
              prefix: "",
              secretAccessKey: "x",
            }) as unknown as V3ReplicaTarget,
        }, "@test/ds"),
      UserError,
    );
    assertStringIncludes(error.message, "secretAccessKey");
    assertEquals(error.message.includes('"x"'), false);
  });
});

const STORE: ReplicaPathStore = {
  list: () => Promise.resolve([]),
  removePath: () => Promise.resolve(),
};

Deno.test("resolveV3ReplicaPaths: binds the provider's store to its own replica target's root", () => {
  assertEquals(
    resolveV3ReplicaPaths({
      replicaPaths: () => STORE,
      replicaTarget: () => ({ type: "s3", bucket: "b", prefix: "team/root" }),
    }, "s3"),
    { root: "s3::b:team/root", store: STORE },
  );
  assertEquals(
    resolveV3ReplicaPaths({
      replicaPaths: () => STORE,
      replicaTarget: () => ({ type: "gcs", bucket: "g", prefix: "" }),
    }, "gcs")?.root,
    "gcs:g:",
  );
});

Deno.test("resolveV3ReplicaPaths: none without replica paths or a replica target", () => {
  assertEquals(resolveV3ReplicaPaths({}, "s3"), undefined);
  assertEquals(
    resolveV3ReplicaPaths({ replicaPaths: () => STORE }, "s3"),
    undefined,
  );
  assertEquals(
    resolveV3ReplicaPaths({
      replicaTarget: () => ({ type: "s3", bucket: "b", prefix: "" }),
    }, "s3"),
    undefined,
  );
});

Deno.test("resolveV3ReplicaPaths: a provider that throws, or a target swamp refuses, gives none and fails nothing", () => {
  const target = () => ({ type: "s3" as const, bucket: "b", prefix: "" });
  assertEquals(
    resolveV3ReplicaPaths({
      replicaPaths: () => {
        throw new Error("not configured");
      },
      replicaTarget: target,
    }, "s3"),
    undefined,
  );
  assertEquals(
    resolveV3ReplicaPaths({
      replicaPaths: () => STORE,
      replicaTarget: () => {
        throw new Error("no endpoint equivalent");
      },
    }, "gcs"),
    undefined,
  );
  assertEquals(
    resolveV3ReplicaPaths({
      replicaPaths: () => STORE,
      replicaTarget: () => ({ type: "s3", bucket: "b", prefix: "/bad" }),
    }, "s3"),
    undefined,
  );
});
