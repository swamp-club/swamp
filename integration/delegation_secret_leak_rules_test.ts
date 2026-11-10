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

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { createDelegationAuditor } from "../src/serve/delegation_audit.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import { START_BODY, withRig } from "./delegation_link_harness.ts";
import { DelegationSyncService } from "../src/serve/delegation_sync_service.ts";
import { ServeLinkClient } from "../src/serve/serve_link_client.ts";
import {
  createDelegationListDeps,
  delegationList,
} from "../src/libswamp/access/delegation_list.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";

function rendered(record: LogRecord): string {
  return JSON.stringify({
    message: record.message.map((part) => String(part)),
    properties: record.properties,
  });
}

/**
 * every secret a link handles is scanned for wherever serve keeps or says
 * anything: its log records, audit events and the files in its repository
 */
Deno.test("delegation links: no token, credential, redeem secret, consent code or client secret reaches logs, audit or stored records", async () => {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      { category: [], lowestLevel: "debug", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  const events: AuditEvent[] = [];
  const auditor = createDelegationAuditor({
    auditEmitter: { emit: (event: AuditEvent) => events.push(event) },
    instanceId: "leak-test",
  });
  const secrets: string[] = ["serve-secret", btoa("serve-client:serve-secret")];
  try {
    await withRig(async (rig) => {
      secrets.push(rig.credential);
      const started = await rig.post("links", START_BODY);
      assertEquals(started.status, 201);
      const consentUrl = started.body.consentUrl as string;
      secrets.push(consentUrl, new URL(consentUrl).searchParams.get("code")!);
      const pendingId = started.body.pendingId as string;
      const redeemSecret = started.body.redeemSecret as string;
      secrets.push(redeemSecret);
      rig.club.status = "approved";
      await rig.service.tick();
      const redeemed = await rig.post("redeem", { pendingId, redeemSecret });
      assertEquals(redeemed.status, 200);
      const firstRefresh = redeemed.body.refreshToken as string;
      secrets.push(redeemed.body.accessToken as string, firstRefresh);
      const refreshed = await rig.post("refresh", {
        refreshToken: firstRefresh,
      });
      secrets.push(refreshed.body.accessToken as string);
      const wrong = `${firstRefresh.slice(0, -1)}0`;
      await rig.post("refresh", { refreshToken: wrong });
      await rig.post("end", { token: firstRefresh });
      await rig.service.tick();
      for (const event of rig.audit) auditor(event);

      const stored: string[] = [];
      for await (
        const entry of walk(rig.repo.repoDir, { includeDirs: false })
      ) {
        stored.push(await Deno.readTextFile(entry.path).catch(() => ""));
      }
      const surfaces = [
        ["logs", records.map(rendered).join("\n")],
        ["audit", JSON.stringify(events)],
        ["stored records", stored.join("\n")],
      ] as const;
      for (const [where, text] of surfaces) {
        for (const secret of secrets) {
          assert(
            !text.includes(secret),
            `${where} holds a secret starting ${secret.slice(0, 6)}`,
          );
        }
        for (const prefix of ["swda1.", "swdr1.", "swdx1.", "swi1."]) {
          assert(!text.includes(prefix), `${where} holds a ${prefix} value`);
        }
      }
      assert(events.length > 0);
      assert(events.every((e) => e.delegation === pendingId));
    });
  } finally {
    await reset();
  }
});

Deno.test("delegation sync and relink: no token, credential or redeem secret reaches logs, audit, stored records or the operator listing", async () => {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      { category: [], lowestLevel: "debug", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  const events: AuditEvent[] = [];
  const auditor = createDelegationAuditor({
    auditEmitter: { emit: (event: AuditEvent) => events.push(event) },
    instanceId: "leak-test",
  });
  const secrets: string[] = ["serve-secret", btoa("serve-client:serve-secret")];
  try {
    await withRig(async (rig) => {
      secrets.push(rig.credential);
      const first = await rig.post("links", START_BODY);
      secrets.push(first.body.redeemSecret as string);
      rig.club.status = "approved";
      await rig.pass();
      const redeemed = await rig.post("redeem", {
        pendingId: first.body.pendingId,
        redeemSecret: first.body.redeemSecret,
      });
      secrets.push(
        redeemed.body.accessToken as string,
        redeemed.body.refreshToken as string,
      );
      const relink = await rig.post("links", START_BODY);
      secrets.push(relink.body.redeemSecret as string);
      await rig.pass();
      const folded = await rig.post("redeem", {
        pendingId: relink.body.pendingId,
        redeemSecret: relink.body.redeemSecret,
      });
      assertEquals(folded.status, 200, JSON.stringify(folded.body));
      secrets.push(
        folded.body.accessToken as string,
        folded.body.refreshToken as string,
      );
      const clock = { now: Date.now() };
      const sync = new DelegationSyncService({
        store: rig.store,
        directory: rig.directory,
        client: () =>
          new ServeLinkClient({
            baseUrl: rig.club.url,
            clientId: "serve-client",
            clientSecret: "serve-secret",
          }),
        isLeader: () => true,
        audit: (event) => rig.audit.push(event),
        now: () => clock.now,
      });
      rig.club.people.set("link-2", { state: "suspended" });
      await sync.tick();
      rig.club.refuseClient = { status: 401, error: "invalid_client" };
      clock.now += 5 * 60_000;
      await sync.tick();
      rig.club.refuseClient = undefined;
      rig.club.endedFeed.push("link-2");
      rig.club.people.set("link-2", {
        state: "ended",
        endedReason: "disowned",
      });
      clock.now += 5 * 60_000;
      await sync.tick();
      await rig.pass();
      for (const event of rig.audit) auditor(event);

      const listing = await Array.fromAsync(
        delegationList(
          createLibSwampContext(),
          createDelegationListDeps(rig.repo.repoContext.dataQueryService),
        ),
      );
      const stored: string[] = [];
      for await (
        const entry of walk(rig.repo.repoDir, { includeDirs: false })
      ) {
        stored.push(await Deno.readTextFile(entry.path).catch(() => ""));
      }
      const surfaces = [
        ["logs", records.map(rendered).join("\n")],
        ["audit", JSON.stringify(events)],
        ["stored records", stored.join("\n")],
        ["--json listing", JSON.stringify(listing)],
      ] as const;
      for (const [where, text] of surfaces) {
        for (const secret of secrets) {
          assert(
            !text.includes(secret),
            `${where} holds a secret starting ${secret.slice(0, 6)}`,
          );
        }
        for (const prefix of ["swda1.", "swdr1.", "swdx1.", "swi1."]) {
          assert(!text.includes(prefix), `${where} holds a ${prefix} value`);
        }
      }
      for (
        const action of [
          "delegation.relinked",
          "delegation.suspended",
          "delegation.ended",
        ]
      ) {
        assert(events.some((e) => e.action === action), action);
      }
    });
  } finally {
    await reset();
  }
});
