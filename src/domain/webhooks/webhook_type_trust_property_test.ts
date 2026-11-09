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

import fc from "fast-check";
import { assertEquals } from "@std/assert";
import { evaluateWebhookTypeTrust } from "./webhook_type_trust.ts";
import type { WebhookTypeOrigin } from "./webhook_type_registry.ts";

const collective = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,7}$/);
const trustList = fc.array(collective, { maxLength: 6 });
const pulledOrigin: fc.Arbitrary<WebhookTypeOrigin | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constant({ kind: "pulled" } as const),
  collective.map((c) =>
    ({ kind: "pulled", extensionName: `@${c}/ext` }) as const
  ),
);

Deno.test("evaluateWebhookTypeTrust: a local type is trusted whatever the list", () => {
  fc.assert(
    fc.property(collective, trustList, (c, list) => {
      assertEquals(
        evaluateWebhookTypeTrust(`@${c}/hook`, { kind: "local" }, list).trusted,
        true,
      );
    }),
  );
});

Deno.test("evaluateWebhookTypeTrust: a pulled type is trusted exactly when every collective it names is listed", () => {
  fc.assert(
    fc.property(collective, pulledOrigin, trustList, (c, origin, list) => {
      const owner = origin?.kind === "pulled" && origin.extensionName
        ? origin.extensionName.slice(1, origin.extensionName.indexOf("/"))
        : undefined;
      const expected = list.includes(c) &&
        (owner === undefined || list.includes(owner));
      assertEquals(
        evaluateWebhookTypeTrust(`@${c}/hook`, origin, list).trusted,
        expected,
      );
    }),
  );
});

Deno.test("evaluateWebhookTypeTrust: the verdict ignores list order, duplicates and case", () => {
  fc.assert(
    fc.property(collective, pulledOrigin, trustList, (c, origin, list) => {
      const scheme = `@${c}/hook`;
      const variant = [...list, ...list].reverse().map((x) => x.toUpperCase());
      assertEquals(
        evaluateWebhookTypeTrust(scheme, origin, variant),
        evaluateWebhookTypeTrust(scheme, origin, list),
      );
    }),
  );
});
