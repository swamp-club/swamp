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
import { probeHostCommandFor } from "./process_bundle_prober.ts";
import {
  BUNDLE_PROBE_HOST_MARKER,
  isBundleProbeHostInvocation,
} from "./bundle_probe_host.ts";

Deno.test("probeHostCommandFor: the swamp binary starts itself with the host marker", () => {
  for (const execPath of ["/usr/local/bin/swamp", "C:\\tools\\swamp.exe"]) {
    assertEquals(probeHostCommandFor(execPath), {
      command: execPath,
      args: [BUNDLE_PROBE_HOST_MARKER],
    });
  }
});

Deno.test("probeHostCommandFor: from source, deno runs the host entry", () => {
  for (
    const execPath of [
      "/home/u/.deno/bin/deno",
      "C:\\Users\\u\\.deno\\bin\\deno.exe",
      "/opt/DENO",
    ]
  ) {
    const command = probeHostCommandFor(execPath);
    assertEquals(command.command, execPath);
    assertEquals(command.args.slice(0, 2), ["run", "-A"]);
    assertEquals(
      command.args[command.args.length - 1].endsWith("bundle_probe_host.ts"),
      true,
    );
  }
});

Deno.test("probeHostCommandFor: a binary whose name only contains deno is not deno", () => {
  assertEquals(probeHostCommandFor("/usr/local/bin/denoise").args, [
    BUNDLE_PROBE_HOST_MARKER,
  ]);
});

Deno.test("isBundleProbeHostInvocation: only the marker as the first argument starts a host", () => {
  assertEquals(isBundleProbeHostInvocation([BUNDLE_PROBE_HOST_MARKER]), true);
  assertEquals(isBundleProbeHostInvocation(["version"]), false);
  assertEquals(
    isBundleProbeHostInvocation(["model", BUNDLE_PROBE_HOST_MARKER]),
    false,
  );
  assertEquals(isBundleProbeHostInvocation([]), false);
});
