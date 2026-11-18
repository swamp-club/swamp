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
import {
  SignInCodeStore,
  type SignInGrant,
} from "../domain/access/sign_in_code.ts";
import { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../domain/serve_audit/audit_event.ts";
import type { AuditSink } from "../domain/serve_audit/audit_sink.ts";
import { SIGN_IN_CODE_REDEEM_PATH } from "./protocol.ts";
import { handleSignInCodeRedeem } from "./sign_in_code_redeem_handler.ts";

const GRANT: SignInGrant = {
  principal: "user:sub-alice",
  username: "alice",
  email: "alice@example.com",
  collectives: ["acme"],
  groups: ["ops"],
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function collectingSink(): AuditSink & { events: AuditEvent[] } {
  const sink = {
    name: "test-collector",
    durable: false,
    events: [] as AuditEvent[],
    write(events: readonly AuditEvent[]): Promise<void> {
      sink.events.push(...events);
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return sink;
}

function redeem(body: unknown, path = SIGN_IN_CODE_REDEEM_PATH): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function fixture() {
  const codes = new SignInCodeStore();
  const sink = collectingSink();
  const emitter = new AuditEmitter([sink]);
  const issued = await codes.issue("edge-dns", GRANT);
  assert(issued.ok);
  return {
    codes,
    sink,
    emitter,
    code: issued.code,
    deps: { codes, sourceIp: "127.0.0.1", auditEmitter: emitter },
  };
}

Deno.test("handleSignInCodeRedeem: answers who the code was issued to, once, uncached", async () => {
  const f = await fixture();
  const first = await handleSignInCodeRedeem(
    redeem({ code: f.code, workspace: "edge-dns" }),
    f.deps,
  );
  assertEquals(first?.status, 200);
  assertEquals(first?.headers.get("cache-control"), "no-store");
  assertEquals(await first?.json(), GRANT);
  const second = await handleSignInCodeRedeem(
    redeem({ code: f.code, workspace: "edge-dns" }),
    f.deps,
  );
  assertEquals(second?.status, 404);
  assertEquals(await second?.json(), { error: "sign_in_code_refused" });
});

Deno.test("handleSignInCodeRedeem: another workspace's code answers as an unknown one does", async () => {
  const f = await fixture();
  const response = await handleSignInCodeRedeem(
    redeem({ code: f.code, workspace: "billing" }),
    f.deps,
  );
  assertEquals(response?.status, 404);
  assertEquals(await response?.json(), { error: "sign_in_code_refused" });
});

Deno.test("handleSignInCodeRedeem: leaves other paths alone and refuses other methods", async () => {
  const f = await fixture();
  assertEquals(
    await handleSignInCodeRedeem(redeem({}, "/auth/device"), f.deps),
    null,
  );
  const get = await handleSignInCodeRedeem(
    new Request(`http://127.0.0.1${SIGN_IN_CODE_REDEEM_PATH}`),
    f.deps,
  );
  assertEquals(get?.status, 405);
});

Deno.test("handleSignInCodeRedeem: a malformed body is refused before any code is looked up", async () => {
  const f = await fixture();
  for (
    const body of [
      "not json",
      null,
      { code: f.code },
      { code: 42, workspace: "edge-dns" },
      { code: "x".repeat(257), workspace: "edge-dns" },
      { code: f.code, workspace: "Edge-DNS" },
    ]
  ) {
    const response = await handleSignInCodeRedeem(redeem(body), f.deps);
    assertEquals(response?.status, 400, JSON.stringify(body));
  }
  assertEquals(f.codes.size, 1, "the code is untouched");
});

Deno.test("handleSignInCodeRedeem: a body past the sign-in limit is refused", async () => {
  const f = await fixture();
  const response = await handleSignInCodeRedeem(
    redeem("x".repeat(17 * 1024)),
    f.deps,
  );
  assertEquals(response?.status, 413);
});

Deno.test("handleSignInCodeRedeem: audits a redeem and the refusal of a code it issued, never a made-up code, and never the code itself", async () => {
  const f = await fixture();
  const other = await f.codes.issue("edge-dns", GRANT);
  assert(other.ok);
  await handleSignInCodeRedeem(
    redeem({ code: f.code, workspace: "edge-dns" }),
    f.deps,
  );
  await handleSignInCodeRedeem(
    redeem({ code: other.code, workspace: "billing" }),
    f.deps,
  );
  const madeUp = await handleSignInCodeRedeem(
    redeem({ code: "swsc1.made-up", workspace: "edge-dns" }),
    f.deps,
  );
  assertEquals(madeUp?.status, 404);
  await f.emitter.flush();
  assertEquals(
    f.sink.events.map((event) => ({
      action: event.action,
      outcome: event.outcome,
      category: event.category,
      resourceName: event.resourceName,
      principalId: event.principalId,
      initiatedBy: event.initiatedBy,
    })),
    [
      {
        action: "auth.sign_in_code.redeemed",
        outcome: "success",
        category: "auth",
        resourceName: "edge-dns",
        principalId: "sub-alice",
        initiatedBy: "user:alice",
      },
      {
        action: "auth.sign_in_code.refused",
        outcome: "denied",
        category: "auth",
        resourceName: "billing",
        principalId: "sub-alice",
        initiatedBy: "user:alice",
      },
    ],
  );
  const recorded = JSON.stringify(f.sink.events);
  assert(!recorded.includes(f.code.split(".")[1]));
  assert(!recorded.includes(other.code.split(".")[1]));
});
