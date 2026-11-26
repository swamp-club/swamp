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
import { modelRegistry } from "../../domain/models/model.ts";
import { FEDERATION_GATE_VARIABLE } from "../../domain/serve/federation_gate.ts";
import type { MergedServeOptions } from "../../serve/serve_config.ts";
import {
  buildServeFederationHub,
  type ServeFederationHubDeps,
} from "./serve_federation_hub.ts";

function deps(
  env: Record<string, string>,
  federation: MergedServeOptions["federation"],
): ServeFederationHubDeps {
  return {
    env: (name) => env[name],
    merged: { federation } as MergedServeOptions,
  } as ServeFederationHubDeps;
}

Deno.test("buildServeFederationHub: builds and registers nothing with the gate off or on a serve that is not a hub", async () => {
  const gateOn = { [FEDERATION_GATE_VARIABLE]: "1" };
  for (
    const [env, federation] of [
      [{}, { role: "hub" }],
      [gateOn, undefined],
      [gateOn, { hub: "https://hub.example", "join-token-file": "token" }],
    ] as const
  ) {
    const registered = modelRegistry.has("swamp/serve-member");
    assertEquals(
      await buildServeFederationHub(
        deps(env, federation as MergedServeOptions["federation"]),
      ),
      undefined,
    );
    assertEquals(modelRegistry.has("swamp/serve-member"), registered);
  }
});
