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
import fc from "fast-check";
import { resolve } from "@std/path";
import { HostConfig } from "./host_config.ts";
import { hostFolderLayout } from "./host_layout.ts";
import { matchWorkspacePath } from "./workspace_path.ts";

const arbName = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,62}$/);
const arbPrefix = fc.array(fc.stringMatching(/^[a-z0-9]{1,8}$/), {
  maxLength: 3,
}).map((segments) => segments.map((s) => `/${s}`).join(""));

Deno.test("HostConfig.childAddress: the router maps any child's address path back to its workspace", () => {
  fc.assert(
    fc.property(arbName, (name) => {
      const config = HostConfig.parse(
        "address: https://serve.example\n",
        hostFolderLayout(resolve("host")),
      );
      const path = new URL(config.childAddress(name)).pathname;
      assertEquals(matchWorkspacePath(path), {
        kind: "workspace",
        name,
        path: "/",
      });
    }),
  );
});

Deno.test("HostConfig.childAddress: a proxy's prefix is kept before /w/<name>", () => {
  fc.assert(
    fc.property(arbPrefix, arbName, (prefix, name) => {
      const config = HostConfig.parse(
        `address: https://serve.example${prefix}/\n`,
        hostFolderLayout(resolve("host")),
      );
      assertEquals(
        config.childAddress(name),
        `https://serve.example${prefix}/w/${name}`,
      );
    }),
  );
});
