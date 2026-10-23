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

import { assert, assertEquals } from "@std/assert";
import { ReplicaRoot } from "./replica_root.ts";

Deno.test("ReplicaRoot.s3: writes the root in its recorded form", () => {
  assertEquals(ReplicaRoot.s3(undefined, "b", "p").value, "s3::b:p");
  assertEquals(
    ReplicaRoot.s3("http://localhost:47441", "b", "p").value,
    "s3:http://localhost:47441:b:p",
  );
});

Deno.test("ReplicaRoot.s3: matches every spelling of the endpoint of its bucket and path (swamp-club#3801)", () => {
  const own = ReplicaRoot.s3("http://localhost:47441", "bucket", "pre/fix");
  for (
    const recorded of [
      "s3:http://localhost:47441:bucket:pre/fix",
      // Proxy vs direct.
      "s3:http://localhost:47411:bucket:pre/fix",
      // A trailing slash, another scheme, another case.
      "s3:http://localhost:47441/:bucket:pre/fix",
      "s3:https://localhost:47441:bucket:pre/fix",
      "s3:HTTP://LOCALHOST:47441:bucket:pre/fix",
      // The default endpoint, implicit or explicit, with or without a scheme.
      "s3::bucket:pre/fix",
      "s3:https://s3.us-east-1.amazonaws.com:bucket:pre/fix",
      "s3:s3.us-east-1.amazonaws.com:bucket:pre/fix",
    ]
  ) {
    assert(own.matches(recorded), recorded);
  }
  assert(
    ReplicaRoot.s3(undefined, "bucket", "pre/fix").matches(
      "s3:http://vpce.example:bucket:pre/fix",
    ),
  );
});

Deno.test("ReplicaRoot.s3: never matches another bucket, path or replica type", () => {
  const own = ReplicaRoot.s3("http://e", "bucket", "pre/fix");
  for (
    const recorded of [
      "s3:http://e:other:pre/fix",
      "s3:http://e:bucket:pre/fix2",
      "s3:http://e:bucket:pre",
      "s3:http://e:bucket:fix",
      "s3:http://e:xbucket:pre/fix",
      "s3:http://e:bucket:xpre/fix",
      // No endpoint, another bucket, a path that ends in this bucket and path.
      "s3::other:x:bucket:pre/fix",
      "gcs:bucket:pre/fix",
      "file:bucket:pre/fix",
      ":bucket:pre/fix",
      "s3:bucket:pre/fix",
      "",
    ]
  ) {
    assert(!own.matches(recorded), recorded);
  }
});

Deno.test("ReplicaRoot.of: matches only its own root", () => {
  const own = ReplicaRoot.of("gcs:g:p");
  assert(own.matches("gcs:g:p"));
  assert(!own.matches("gcs:g:p/"));
  assert(!own.matches("s3::g:p"));
  assert(!ReplicaRoot.of("file:/a").matches("file:/b"));
});
