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
import fc from "fast-check";
import { agentSessionDataName } from "../../../../src/domain/agent_sessions/session_record.ts";
import { sessionRefTarget } from "./swampify_view.ts";

Deno.test("sessionRefTarget: never throws, and links only a name in the loaded list", () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.string(),
      fc.array(fc.string()),
      (harness, sessionId, others) => {
        const loaded = new Set(others);
        const target = sessionRefTarget({ harness, sessionId }, loaded);
        assert(target === null || loaded.has(target));
      },
    ),
  );
});

const slug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,31}$/);
const id = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,63}$/);

Deno.test("sessionRefTarget: a valid ref links to its session exactly when that session is loaded", () => {
  fc.assert(
    fc.property(
      slug,
      id,
      fc.array(fc.tuple(slug, id)),
      fc.boolean(),
      (harness, sessionId, others, isLoaded) => {
        const name = agentSessionDataName(harness, sessionId);
        const loaded = new Set(
          others.map(([h, s]) => agentSessionDataName(h, s)).filter((n) =>
            n !== name
          ),
        );
        if (isLoaded) loaded.add(name);
        const target = sessionRefTarget({ harness, sessionId }, loaded);
        return target === (isLoaded ? name : null);
      },
    ),
  );
});
