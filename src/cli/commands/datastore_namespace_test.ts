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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { refuseNamespaceChangeOnV3 } from "./datastore_namespace.ts";

const filesystem: DatastoreConfig = { type: "filesystem", path: "/ds" };

function extension(type: string): DatastoreConfig {
  return {
    type,
    config: {},
    datastorePath: "/ds",
    cachePath: "/cache",
  };
}

Deno.test("refuseNamespaceChangeOnV3: names the datastore's own v3 setup command (swamp-club#3644)", () => {
  const cases: [DatastoreConfig, string][] = [
    [filesystem, "swamp datastore setup filesystem --path <dir> --format 3"],
    [
      extension("@swamp/s3-datastore"),
      "swamp datastore setup extension @swamp/s3-datastore --config '...' " +
      "--format 3",
    ],
    [
      extension("@swamp/gcs-datastore"),
      "swamp datastore setup extension @swamp/gcs-datastore --config '...' " +
      "--format 3",
    ],
  ];
  for (const [config, setup] of cases) {
    const error = assertThrows(
      () => refuseNamespaceChangeOnV3("v3", config),
      UserError,
    );
    assertEquals(
      error.message,
      "Changing the namespace of a v3 datastore is not supported yet: its " +
        "commits are recorded per namespace. To use a namespace, run " +
        `\`swamp datastore namespace set <name>\` before \`${setup}\`.`,
      config.type,
    );
  }
});

Deno.test("refuseNamespaceChangeOnV3: a v2 datastore's namespace may change", () => {
  refuseNamespaceChangeOnV3("v2", filesystem);
  refuseNamespaceChangeOnV3("v2", extension("@swamp/s3-datastore"));
});
