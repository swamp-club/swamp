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
import { ProcessRuntime } from "../runtime/process_runtime.ts";
import {
  hasWorkspaceSignInGap,
  loginHintFor,
  recordWorkspaceSignIn,
  workspaceRefusalHintFor,
} from "./workspace_sign_in_notes.ts";

const HOST = "https://host.example";
const WORKSPACE = `${HOST}/w/team`;

function inOwnRuntime(fn: () => void): Promise<void> {
  return new ProcessRuntime(crypto.randomUUID()).run(() => {
    fn();
    return Promise.resolve();
  });
}

Deno.test("recordWorkspaceSignIn: a gap is found under any spelling of the address and names the host", async () => {
  await inOwnRuntime(() => {
    recordWorkspaceSignIn(WORKSPACE, HOST, "no-host-token");
    assertEquals(hasWorkspaceSignInGap("wss://host.example/w/team/"), true);
    assertEquals(
      loginHintFor("wss://host.example/w/team"),
      "Authentication failed — run: swamp auth server-login --server https://host.example (one sign-in to the host covers its workspaces)",
    );
    assertEquals(workspaceRefusalHintFor(WORKSPACE), undefined);
  });
});

Deno.test("recordWorkspaceSignIn: an exchanged token is not a gap and gives the refusal hint", async () => {
  await inOwnRuntime(() => {
    recordWorkspaceSignIn(WORKSPACE, HOST, "exchanged-token");
    assertEquals(hasWorkspaceSignInGap(WORKSPACE), false);
    assertEquals(
      workspaceRefusalHintFor("ws://host.example/w/team"),
      undefined,
    );
    assertEquals(
      workspaceRefusalHintFor("wss://host.example/w/team"),
      `Behind a host this is also how a workspace refusing your token reads; signing in to the host again replaces it: swamp auth server-login --server ${HOST}`,
    );
  });
});

Deno.test("recordWorkspaceSignIn: one process runtime's notes are not another's", async () => {
  await inOwnRuntime(() =>
    recordWorkspaceSignIn(WORKSPACE, HOST, "no-host-token")
  );
  await inOwnRuntime(() => {
    assertEquals(hasWorkspaceSignInGap(WORKSPACE), false);
    assertEquals(
      loginHintFor(WORKSPACE),
      `Authentication failed — run: swamp auth server-login --server ${WORKSPACE}`,
    );
  });
});

Deno.test("loginHintFor: an address that does not parse gets the plain hint", async () => {
  await inOwnRuntime(() => {
    assertEquals(
      loginHintFor("not a url"),
      "Authentication failed — run: swamp auth server-login --server not a url",
    );
    assertEquals(hasWorkspaceSignInGap("not a url"), false);
  });
});
