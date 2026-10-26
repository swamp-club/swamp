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
  type DeclaredIdentity,
  identityRefusal,
  isCanonicalRunLogFile,
  type KeyFacts,
} from "./content_bindings.ts";
import type { Intent } from "./intent.ts";

const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);
const type = fc.stringMatching(/^[a-z]{1,6}\/[a-z]{1,6}$/);

/** A definition put whose content declares exactly what its intent and key name. */
const bound = fc.record({
  id: fc.uuid(),
  name,
  type,
  uuidKey: fc.boolean(),
  edit: fc.boolean(),
});

function scenario(b: {
  id: string;
  name: string;
  type: string;
  uuidKey: boolean;
  edit: boolean;
}): {
  intent: Intent;
  key: KeyFacts;
  declared: DeclaredIdentity;
  stored?: DeclaredIdentity;
} {
  const declared = { id: b.id, name: b.name, type: b.type };
  return {
    intent: {
      kind: b.edit ? "definition.edit" : "definition.create",
      definition: { kind: "model", name: b.name },
    },
    key: { type: b.type, ...(b.uuidKey ? { fileId: b.id.toLowerCase() } : {}) },
    declared,
    ...(b.edit ? { stored: declared } : {}),
  };
}

Deno.test("identityRefusal (property): content declaring its own identity always passes", () => {
  fc.assert(
    fc.property(bound, (b) => {
      const s = scenario(b);
      assertEquals(
        identityRefusal(s.intent, s.key, s.declared, s.stored),
        undefined,
      );
    }),
  );
});

Deno.test("identityRefusal (property): changing any one declared field away from its binding refuses", () => {
  fc.assert(
    fc.property(
      bound,
      fc.constantFrom("id" as const, "name" as const, "type" as const),
      fc.uuid(),
      name,
      type,
      (b, field, otherId, otherName, otherType) => {
        const s = scenario(b);
        const changed = { ...s.declared };
        if (field === "id") changed.id = otherId;
        if (field === "name") changed.name = otherName;
        if (field === "type") changed.type = otherType;
        fc.pre(changed[field] !== s.declared[field]);
        // An id is only bound by a uuid key or a stored definition.
        fc.pre(field !== "id" || b.uuidKey || b.edit);
        assert(
          identityRefusal(s.intent, s.key, changed, s.stored) !== undefined,
          `${field} changed`,
        );
      },
    ),
  );
});

Deno.test("isCanonicalRunLogFile (property): any path but the run's own is refused", () => {
  fc.assert(
    fc.property(
      fc.uuid(),
      fc.uuid(),
      fc.string(),
      (workflowId, runId, path) => {
        const own =
          `.swamp/workflow-runs/${workflowId}/workflow-run-${runId}.log`;
        fc.pre(path.replaceAll("\\", "/") !== own);
        assert(!isCanonicalRunLogFile(path, workflowId, runId));
      },
    ),
  );
});
