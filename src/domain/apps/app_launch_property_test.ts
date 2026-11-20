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
import fc from "fast-check";
import {
  base64urlDecode,
  base64urlEncode,
} from "../auth/verification_proof.ts";
import {
  APP_LAUNCH_TOKEN_PATTERN,
  appApprovalStamp,
  launchMatchesApproval,
  mintAppLaunchToken,
  verifyAppLaunchToken,
} from "./app_launch.ts";

const NOW = Date.parse("2026-11-04T00:00:00.000Z");

const segment = fc.stringMatching(/^[a-z0-9_-]{1,20}$/);
const names = fc.tuple(segment, segment).map(([a, b]) => `@${a}/${b}`);
const keys = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((bytes) =>
  new Uint8Array(bytes)
);
const approvals = fc.record({
  capabilityKey: fc.string({ minLength: 1, maxLength: 40 }),
  approvedAt: fc.date({
    min: new Date("2020-01-01T00:00:00.000Z"),
    max: new Date("2030-01-01T00:00:00.000Z"),
  }).map((date) => date.toISOString()),
});
// whole seconds ahead, as the token carries the expiry in seconds
const lifetimes = fc.integer({ min: 1, max: 8 * 60 * 60 }).map((s) => s * 1000);

const launches = fc.record({
  key: keys,
  name: names,
  approval: approvals,
  lifetime: lifetimes,
});

async function mint(
  launch: {
    key: Uint8Array<ArrayBuffer>;
    name: string;
    approval: { capabilityKey: string; approvedAt: string };
    lifetime: number;
  },
): Promise<string> {
  return await mintAppLaunchToken(launch.key, {
    name: launch.name,
    expiresAt: NOW + launch.lifetime,
    approvalStamp: await appApprovalStamp(launch.approval),
  });
}

Deno.test("verifyAppLaunchToken: a minted token verifies to what was minted", async () => {
  await fc.assert(
    fc.asyncProperty(launches, async (launch) => {
      const token = await mint(launch);
      assert(APP_LAUNCH_TOKEN_PATTERN.test(token));
      const claims = await verifyAppLaunchToken(launch.key, token, NOW);
      assertEquals(claims?.name, launch.name);
      assertEquals(claims?.expiresAt, NOW + launch.lifetime);
      assert(claims && await launchMatchesApproval(claims, launch.approval));
    }),
  );
});

Deno.test("verifyAppLaunchToken: flipping any bit of any byte refuses it", async () => {
  await fc.assert(
    fc.asyncProperty(
      launches,
      fc.nat(),
      fc.integer({ min: 0, max: 7 }),
      async (launch, at, bit) => {
        const bytes = base64urlDecode(await mint(launch));
        bytes[at % bytes.length] ^= 1 << bit;
        assertEquals(
          await verifyAppLaunchToken(
            launch.key,
            base64urlEncode(bytes),
            NOW,
          ),
          null,
        );
      },
    ),
  );
});

Deno.test("verifyAppLaunchToken: another key refuses it", async () => {
  await fc.assert(
    fc.asyncProperty(launches, keys, async (launch, other) => {
      fc.pre(base64urlEncode(other) !== base64urlEncode(launch.key));
      assertEquals(
        await verifyAppLaunchToken(other, await mint(launch), NOW),
        null,
      );
    }),
  );
});

Deno.test("verifyAppLaunchToken: any truncation refuses it", async () => {
  await fc.assert(
    fc.asyncProperty(launches, fc.nat(), async (launch, cut) => {
      const token = await mint(launch);
      const short = token.slice(0, cut % token.length);
      assertEquals(await verifyAppLaunchToken(launch.key, short, NOW), null);
    }),
  );
});

Deno.test("verifyAppLaunchToken: refused from its expiry on", async () => {
  await fc.assert(
    fc.asyncProperty(launches, fc.nat(), async (launch, after) => {
      const token = await mint(launch);
      assertEquals(
        await verifyAppLaunchToken(
          launch.key,
          token,
          NOW + launch.lifetime + after,
        ),
        null,
      );
    }),
  );
});

Deno.test("verifyAppLaunchToken: another app's name never verifies in its place", async () => {
  await fc.assert(
    fc.asyncProperty(launches, names, async (launch, other) => {
      fc.pre(other !== launch.name);
      const claims = await verifyAppLaunchToken(
        launch.key,
        await mint(launch),
        NOW,
      );
      assert(claims !== null && claims.name !== other);
      const spliced = base64urlDecode(await mint({ ...launch, name: other }));
      const original = base64urlDecode(await mint(launch));
      // the other app's claims under this launch's signature
      const forged = new Uint8Array(spliced.length);
      forged.set(spliced.subarray(0, spliced.length - 32));
      forged.set(original.subarray(original.length - 32), spliced.length - 32);
      assertEquals(
        await verifyAppLaunchToken(launch.key, base64urlEncode(forged), NOW),
        null,
      );
    }),
  );
});

Deno.test("launchMatchesApproval: a different approval does not match", async () => {
  await fc.assert(
    fc.asyncProperty(launches, approvals, async (launch, other) => {
      fc.pre(
        other.capabilityKey !== launch.approval.capabilityKey ||
          other.approvedAt !== launch.approval.approvedAt,
      );
      const claims = await verifyAppLaunchToken(
        launch.key,
        await mint(launch),
        NOW,
      );
      assert(claims !== null);
      assertEquals(await launchMatchesApproval(claims, other), false);
    }),
  );
});

Deno.test("verifyAppLaunchToken: text that is not a token is refused", async () => {
  await fc.assert(
    fc.asyncProperty(keys, fc.string({ maxLength: 300 }), async (key, text) => {
      assertEquals(await verifyAppLaunchToken(key, text, NOW), null);
    }),
  );
});
