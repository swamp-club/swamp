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

import { assertStringIncludes, assertThrows } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import { checkReusePortListen } from "./reuse_port_check.ts";

Deno.test({
  name:
    "checkReusePortListen: refuses a port another process holds without reuse-port",
  ignore: Deno.build.os === "windows",
  fn: () => {
    const holder = Deno.listen({ port: 0, hostname: "127.0.0.1" });
    try {
      const error = assertThrows(
        () =>
          checkReusePortListen({
            port: (holder.addr as Deno.NetAddr).port,
            hostname: "127.0.0.1",
          }),
        UserError,
      );
      assertStringIncludes(error.message, "without --reuse-port");
    } finally {
      holder.close();
    }
  },
});

Deno.test({
  name: "checkReusePortListen: accepts a port shared with reuse-port",
  // only Linux lets two sockets share a port
  ignore: Deno.build.os !== "linux",
  fn: () => {
    const holder = Deno.listen({
      port: 0,
      hostname: "127.0.0.1",
      reusePort: true,
    });
    try {
      checkReusePortListen({
        port: (holder.addr as Deno.NetAddr).port,
        hostname: "127.0.0.1",
      });
    } finally {
      holder.close();
    }
  },
});

Deno.test("checkReusePortListen: a certificate and key that do not load fail before startup", () => {
  assertThrows(() =>
    checkReusePortListen({
      port: 0,
      hostname: "127.0.0.1",
      cert: "not a certificate",
      key: "not a key",
    })
  );
});
