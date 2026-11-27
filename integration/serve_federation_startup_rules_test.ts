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

import { assert } from "@std/assert";
import { fromFileUrl } from "@std/path";

const SERVE = fromFileUrl(
  new URL("../src/cli/commands/serve.ts", import.meta.url),
);

// a single node leads at once, so the hub's first beat reads readiness while serve is still starting
Deno.test("serve startup: readiness is declared before the federation services that read it are built", async () => {
  const source = await Deno.readTextFile(SERVE);
  const hub = source.indexOf("await buildServeFederationHub(");
  const member = source.indexOf("buildServeFederationMember(");
  assert(
    hub > 0 && member > 0,
    "the federation services are built in serve.ts",
  );
  for (const declaration of ["let isReady", "let shuttingDown"]) {
    const at = source.indexOf(declaration);
    assert(at > 0, `${declaration} is declared in serve.ts`);
    assert(
      at < hub && at < member,
      `${declaration} must come before the federation services are built`,
    );
  }
});
