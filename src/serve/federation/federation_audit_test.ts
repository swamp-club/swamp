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
import type { AuditEmitter } from "../../domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import { sampleFingerprintProps } from "../../domain/serve/federation_test_helpers.ts";
import { resetRateLimitState } from "../rate_limiter.ts";
import { WebhookRejectionCoalescer } from "../webhook_audit_coalescer.ts";
import {
  FEDERATION_AUDIT_ACTIONS,
  FederationAudit,
} from "./federation_audit.ts";
import { createTestHub } from "./federation_hub_test_helpers.ts";
import {
  FEDERATION_CHECK_IN_PATH,
  FEDERATION_JOIN_PATH,
  handleFederationRequest,
} from "./hub_routes.ts";

function capture(): { events: AuditEvent[]; emitter: AuditEmitter } {
  const events: AuditEvent[] = [];
  return {
    events,
    emitter: {
      emit: (event: AuditEvent) => events.push(event),
    } as unknown as AuditEmitter,
  };
}

Deno.test("FederationAudit: refused check-ins are coalesced per reason with the suppressed count", () => {
  const { events, emitter } = capture();
  let now = 0;
  const audit = new FederationAudit({
    auditEmitter: () => emitter,
    coalescer: new WebhookRejectionCoalescer({ now: () => now }),
  });
  for (let i = 0; i < 4; i++) audit.checkInRefused("10.0.0.1", "unauthorized");
  audit.checkInRefused("10.0.0.1", "instance_limit");
  now += 60_000;
  audit.checkInRefused("10.0.0.1", "unauthorized");
  assertEquals(events.map((e) => e.detail), [
    "reason=unauthorized",
    "reason=instance_limit",
    "reason=unauthorized suppressed=3",
  ]);
  for (const event of events) {
    assertEquals(event.category, "auth");
    assertEquals(event.principalId, "anonymous");
  }
});

Deno.test("FederationAudit: no emitter, no event and no error", () => {
  const audit = new FederationAudit({ auditEmitter: () => undefined });
  audit.joined("10.0.0.1", "edge-1");
  audit.joinRefused("10.0.0.1", "invalid_token");
});

Deno.test("FederationAudit: joins through the routes are audited as anonymous, never with the token or credential", async () => {
  resetRateLimitState();
  const { events, emitter } = capture();
  const audit = new FederationAudit({ auditEmitter: () => emitter });
  const t = createTestHub();
  const { plaintext } = await t.hub.createToken("edge-1");
  const secret = plaintext.split(".")[1];
  const body = (joinToken: string) =>
    JSON.stringify({
      protocolVersion: 1,
      fingerprint: sampleFingerprintProps(),
      joinToken,
    });
  const post = (path: string, payload: string, auth?: string) =>
    new Request(`http://hub.test${path}`, {
      method: "POST",
      body: payload,
      ...(auth ? { headers: { authorization: `Bearer ${auth}` } } : {}),
    });
  const deps = { hub: t.hub, clientAddress: "10.9.8.7", audit };
  const joined = await handleFederationRequest(
    post(FEDERATION_JOIN_PATH, body(plaintext)),
    deps,
  );
  const { credential } = await joined!.json();
  const again = await handleFederationRequest(
    post(FEDERATION_JOIN_PATH, body(plaintext)),
    deps,
  );
  await again?.body?.cancel();
  const checkIn = await handleFederationRequest(
    post(
      FEDERATION_CHECK_IN_PATH,
      JSON.stringify({
        protocolVersion: 1,
        fingerprint: sampleFingerprintProps(),
        instanceId: crypto.randomUUID(),
      }),
      `${credential}x`,
    ),
    deps,
  );
  assertEquals(checkIn?.status, 401);
  await checkIn?.body?.cancel();

  assertEquals(events.map((e) => [e.action, e.outcome, e.resourceName]), [
    [FEDERATION_AUDIT_ACTIONS.join, "success", "edge-1"],
    [FEDERATION_AUDIT_ACTIONS.join, "failure", "edge-1"],
    [FEDERATION_AUDIT_ACTIONS.checkInRejected, "failure", "check-in"],
  ]);
  const text = JSON.stringify(events);
  assert(!text.includes(secret));
  assert(!text.includes(credential.split(".")[2]));
  for (const event of events) assertEquals(event.principalKind, "anonymous");
});
