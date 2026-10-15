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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import fc from "fast-check";
import { YamlDefinitionRepository } from "./yaml_definition_repository.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";

// Property: whatever a save merges onto an existing definition file — scalar
// edits made in place, structural changes merged onto the document, anchors
// changed under their aliases — the file reads back as exactly the data that
// was saved (swamp-club#3502).

const testType = ModelType.create("test/merge-property");

type DefinitionData = Parameters<typeof Definition.fromData>[0];

/** Strings that read as another type, or need quoting, when written plain. */
const arbString = fc.oneof(
  fc.constantFrom(
    "",
    "=",
    "true",
    "no",
    "null",
    "123",
    "1.5",
    "2026-09-03",
    "a: b",
    "# not a comment",
    "*alias",
    "&anchor",
    "line one\nline two",
    " padded ",
    "x".repeat(100),
  ),
  fc.string({ maxLength: 12 }),
);

const arbPrimitive = fc.oneof(
  arbString,
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null),
);

const arbKey = fc.constantFrom("alpha", "beta", "gamma", "delta", "op");

const { value: arbValue } = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    arbPrimitive,
    fc.array(tie("value"), { maxLength: 3 }),
    fc.dictionary(arbKey, tie("value"), { maxKeys: 3 }),
  ),
}));

const arbArgs = fc.dictionary(arbKey, arbValue, { maxKeys: 4 });

function dataFor(
  id: string,
  globalArguments: Record<string, unknown>,
  typeVersion = "2026.06.04.2",
): Record<string, unknown> {
  return {
    type: testType.normalized,
    typeVersion,
    id,
    name: "merged",
    version: 1,
    tags: {},
    globalArguments,
    methods: {},
  };
}

function readBack(text: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(parseYaml(text)));
}

async function withRepo(
  fn: (repo: YamlDefinitionRepository, typeDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const typeDir = join(dir, "models", testType.toDirectoryPath());
    await ensureDir(typeDir);
    await fn(new YamlDefinitionRepository(dir), typeDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("YamlDefinitionRepository.save: a merged save onto a commented file reads back as the saved data", async () => {
  await fc.assert(
    fc.asyncProperty(arbArgs, arbArgs, async (before, after) => {
      await withRepo(async (repo, typeDir) => {
        const id = crypto.randomUUID();
        await repo.save(
          testType,
          Definition.fromData(dataFor(id, before) as DefinitionData),
        );
        const path = join(typeDir, "merged.yaml");
        await Deno.writeTextFile(
          path,
          "# hand-written comment\n" + await Deno.readTextFile(path),
        );

        const expected = dataFor(id, after, "2026.07.28.1");
        await repo.save(
          testType,
          Definition.fromData(
            JSON.parse(JSON.stringify(expected)) as DefinitionData,
          ),
        );

        assertEquals(readBack(await Deno.readTextFile(path)), expected);
      });
    }),
    { numRuns: 150 },
  );
});

/** `value` with its leaves replaced, in order, by the defined `edits`. */
function editLeaves(value: unknown, edits: unknown[]): unknown {
  if (Array.isArray(value)) return value.map((item) => editLeaves(item, edits));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, editLeaves(v, edits)]),
    );
  }
  const edit = edits.shift();
  return edit === undefined ? value : edit;
}

Deno.test("YamlDefinitionRepository.save: scalar-only edits to a commented file read back as the saved data", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbArgs,
      fc.array(fc.option(arbPrimitive, { nil: undefined, freq: 2 }), {
        maxLength: 12,
      }),
      async (before, edits) => {
        await withRepo(async (repo, typeDir) => {
          const id = crypto.randomUUID();
          await repo.save(
            testType,
            Definition.fromData(dataFor(id, before) as DefinitionData),
          );
          const path = join(typeDir, "merged.yaml");
          await Deno.writeTextFile(
            path,
            "# hand-written comment\n" + await Deno.readTextFile(path),
          );

          const after = editLeaves(before, [...edits]) as Record<
            string,
            unknown
          >;
          const expected = dataFor(id, after, "2026.07.28.1");
          await repo.save(
            testType,
            Definition.fromData(
              JSON.parse(JSON.stringify(expected)) as DefinitionData,
            ),
          );

          const saved = await Deno.readTextFile(path);
          assertEquals(readBack(saved), expected);
          assertEquals(saved.startsWith("# hand-written comment\n"), true);
        });
      },
    ),
    { numRuns: 150 },
  );
});

/** A file whose arguments share an anchored map through an alias. */
function anchoredYaml(id: string): string {
  return [
    `type: ${testType.normalized}`,
    "typeVersion: 2026.06.04.2",
    `id: ${id}`,
    "name: merged",
    "version: 1",
    "tags: {}",
    "globalArguments:",
    "  recipients:",
    "    # the on-call alias",
    "    - oncall@example.com",
    "  createTrigger:",
    "    arguments: &trigger_args",
    "      threshold: 5",
    "      window: 10m",
    "  updateTrigger: { arguments: *trigger_args }",
    "  filters:",
    "    - field: status",
    "      op: '='",
    "methods: {}",
    "",
  ].join("\n");
}

const arbLeafEdit = fc.option(arbPrimitive, { nil: undefined });

Deno.test("YamlDefinitionRepository.save: editing either side of an anchor and its alias reads back as the saved data", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        createThreshold: arbLeafEdit,
        createWindow: arbLeafEdit,
        updateThreshold: arbLeafEdit,
        updateWindow: arbLeafEdit,
        op: arbLeafEdit,
        recipient: arbLeafEdit,
        extra: fc.option(arbValue, { nil: undefined, freq: 2 }),
      }),
      async (edit) => {
        await withRepo(async (repo, typeDir) => {
          const id = crypto.randomUUID();
          const path = join(typeDir, `${id}.yaml`);
          const original = anchoredYaml(id);
          await Deno.writeTextFile(path, original);

          const expected = readBack(original);
          expected.typeVersion = "2026.07.28.1";
          // deno-lint-ignore no-explicit-any
          const args = expected.globalArguments as any;
          const set = (
            target: Record<string, unknown>,
            key: string,
            v: unknown,
          ) => {
            if (v !== undefined) target[key] = v;
          };
          set(args.createTrigger.arguments, "threshold", edit.createThreshold);
          set(args.createTrigger.arguments, "window", edit.createWindow);
          set(args.updateTrigger.arguments, "threshold", edit.updateThreshold);
          set(args.updateTrigger.arguments, "window", edit.updateWindow);
          set(args.filters[0], "op", edit.op);
          set(args.recipients, "0", edit.recipient);
          set(args, "extra", edit.extra);

          await repo.save(
            testType,
            Definition.fromData(
              JSON.parse(JSON.stringify(expected)) as DefinitionData,
            ),
          );

          assertEquals(
            readBack(await Deno.readTextFile(join(typeDir, "merged.yaml"))),
            expected,
          );
        });
      },
    ),
    { numRuns: 150 },
  );
});
