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
import * as fc from "fast-check";
import {
  HTTP_ACTION_RULES,
  parseActionRequest,
} from "./http_action_request.ts";
import { HTTP_ACTION_TYPES } from "./protocol.ts";

const SERVER_SET = [
  "decidedBy",
  "lockHolderTokens",
  "suspendedOnly",
  "exactRun",
  "strictGate",
  "initiatedBy",
  "client",
];

Deno.test("parseActionRequest property: never throws on any input", () => {
  fc.assert(
    fc.property(fc.jsonValue(), fc.boolean(), (raw, anonymous) => {
      parseActionRequest(raw, { anonymous });
    }),
  );
});

Deno.test("parseActionRequest property: an unlisted type never builds a frame", () => {
  fc.assert(
    fc.property(fc.string(), fc.jsonValue(), (type, payload) => {
      fc.pre(!HTTP_ACTION_TYPES.has(type));
      assertEquals(
        parseActionRequest({ type, payload }, {
          anonymous: false,
        }).ok,
        false,
      );
    }),
  );
});

Deno.test("parseActionRequest property: a caller's value never reaches a server-set field", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...Object.keys(HTTP_ACTION_RULES)),
      fc.constantFrom(...SERVER_SET),
      fc.jsonValue(),
      (type, field, value) => {
        const request = parseActionRequest({
          type,
          payload: {
            workflowIdOrName: "w",
            idempotencyKey: "k",
            runId: "0b6f9a44-5c0d-4a6e-9a43-7a4f3f0c1d2e",
            stepName: "s",
            suspendedAt: "2026-11-06T10:00:00.000Z",
            [field]: value,
          },
        }, { anonymous: false });
        // these payloads hold other types' fields too, so most are refused;
        // one that passes must carry only what serve set
        if (!request.ok) return;
        const { payload } = JSON.parse(request.frame);
        assert(payload === undefined || payload[field] !== value);
      },
    ),
  );
});
