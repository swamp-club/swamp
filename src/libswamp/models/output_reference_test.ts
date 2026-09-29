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
import { Definition } from "../../domain/definitions/definition.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  type OutputMatchResult,
  type OutputReferenceDeps,
  resolveOutputIdReference,
  resolveOutputReference,
} from "./output_reference.ts";

interface FakeOutput {
  id: string;
  definitionId: string;
}

const TYPE = ModelType.create("test/output-reference");

function definition(name: string, id: string): Definition {
  return Definition.create({ id, name, version: 1 });
}

/** Deps over an in-memory set of outputs and definitions, recording calls. */
function fakeDeps(
  outputs: FakeOutput[],
  definitions: Definition[],
): OutputReferenceDeps<FakeOutput> & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isPartialId,
    matchOutputByPartialId: (
      prefix,
    ): Promise<OutputMatchResult<FakeOutput>> => {
      calls.push(`match:${prefix}`);
      const result = matchByPartialId(
        outputs.map((output) => ({ id: output.id, item: output })),
        prefix,
      );
      if (result.status === "found") {
        return Promise.resolve({
          status: "found",
          match: { output: result.match, type: TYPE },
        });
      }
      if (result.status === "ambiguous") {
        return Promise.resolve({
          status: "ambiguous",
          matches: result.matches.map((m) => ({
            id: m.id,
            match: { output: m.match, type: TYPE },
          })),
        });
      }
      return Promise.resolve({ status: "not_found" });
    },
    findDefinitionByIdOrName: (idOrName) => {
      calls.push(`definition:${idOrName}`);
      const found = definitions.find((d) => d.name === idOrName) ??
        definitions.find((d) => d.id === idOrName);
      return Promise.resolve(found ? { definition: found, type: TYPE } : null);
    },
    findLatestOutput: (_type, definitionId) => {
      calls.push(`latest:${definitionId}`);
      return Promise.resolve(
        outputs.filter((o) => o.definitionId === definitionId).at(-1) ?? null,
      );
    },
  };
}

const MODEL = definition("my-model", "00000000-0000-4000-8000-000000000001");
const OUT_A = {
  id: "aaaa0000-0000-4000-8000-000000000001",
  definitionId: MODEL.id,
};
const OUT_B = {
  id: "aaaa1111-0000-4000-8000-000000000001",
  definitionId: MODEL.id,
};

Deno.test("resolveOutputReference: an output id prefix resolves to that output", async () => {
  const deps = fakeDeps([OUT_A, OUT_B], [MODEL]);
  assertEquals(await resolveOutputReference(deps, "aaaa0"), {
    kind: "output",
    match: { output: OUT_A, type: TYPE },
  });
  assertEquals(deps.calls, ["match:aaaa0"]);
});

Deno.test("resolveOutputReference: a full output id resolves to that output", async () => {
  const deps = fakeDeps([OUT_A, OUT_B], [MODEL]);
  const reference = await resolveOutputReference(deps, OUT_B.id);
  assertEquals(reference.kind === "output" && reference.match.output, OUT_B);
});

Deno.test("resolveOutputReference: a prefix matching several outputs is ambiguous, never a model", async () => {
  const deps = fakeDeps([OUT_A, OUT_B], [definition("aaaa", MODEL.id)]);
  const reference = await resolveOutputReference(deps, "aaaa");
  assertEquals(reference.kind, "ambiguous");
  assertEquals(
    reference.kind === "ambiguous" && reference.ids.sort(),
    [OUT_A.id, OUT_B.id],
  );
  assertEquals(deps.calls, ["match:aaaa"]);
});

Deno.test("resolveOutputReference: a hex model name loses to an output it prefixes", async () => {
  const hexNamed = definition("aaaa0", "00000000-0000-4000-8000-000000000002");
  const deps = fakeDeps([OUT_A], [hexNamed]);
  const reference = await resolveOutputReference(deps, "aaaa0");
  assertEquals(reference.kind, "output");
});

Deno.test("resolveOutputReference: a hex model name matching no output resolves to the model", async () => {
  const hexNamed = definition("bbbb0", "00000000-0000-4000-8000-000000000002");
  const deps = fakeDeps([OUT_A], [hexNamed]);
  const reference = await resolveOutputReference(deps, "bbbb0");
  assertEquals(reference, {
    kind: "model",
    definition: hexNamed,
    type: TYPE,
    latest: null,
  });
});

Deno.test("resolveOutputReference: a model name resolves to the model with its latest output", async () => {
  const deps = fakeDeps([OUT_A, OUT_B], [MODEL]);
  assertEquals(await resolveOutputReference(deps, "my-model"), {
    kind: "model",
    definition: MODEL,
    type: TYPE,
    latest: OUT_B,
  });
  // Not hex: no output match is attempted.
  assertEquals(deps.calls, ["definition:my-model", `latest:${MODEL.id}`]);
});

Deno.test("resolveOutputReference: a model id matching no output resolves to the model", async () => {
  const deps = fakeDeps([OUT_A], [MODEL]);
  const reference = await resolveOutputReference(deps, MODEL.id);
  assertEquals(reference.kind === "model" && reference.definition, MODEL);
  assertEquals(reference.kind === "model" && reference.latest, OUT_A);
});

Deno.test("resolveOutputReference: nothing matching is not found", async () => {
  const deps = fakeDeps([OUT_A], [MODEL]);
  assertEquals(await resolveOutputReference(deps, "no-such-thing"), {
    kind: "not_found",
  });
  assertEquals(await resolveOutputReference(deps, "fedcba"), {
    kind: "not_found",
  });
});

Deno.test("resolveOutputIdReference: a non-hex argument is invalid and looks nothing up", async () => {
  const deps = fakeDeps([OUT_A], [MODEL]);
  assertEquals(await resolveOutputIdReference(deps, "my-model"), {
    kind: "invalid",
  });
  assertEquals(deps.calls, []);
});

Deno.test("resolveOutputIdReference: never falls back to a model", async () => {
  const hexNamed = definition("bbbb0", "00000000-0000-4000-8000-000000000002");
  const deps = fakeDeps([OUT_A, OUT_B], [hexNamed]);
  assertEquals(await resolveOutputIdReference(deps, "bbbb0"), {
    kind: "not_found",
  });
  assertEquals(
    (await resolveOutputIdReference(deps, "aaaa")).kind,
    "ambiguous",
  );
  assertEquals(
    await resolveOutputIdReference(deps, "aaaa1"),
    { kind: "output", match: { output: OUT_B, type: TYPE } },
  );
  assertEquals(
    deps.calls.some((call) => call.startsWith("definition:")),
    false,
  );
});
