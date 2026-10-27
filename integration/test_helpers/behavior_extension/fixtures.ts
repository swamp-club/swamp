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

/**
 * Model-spelled extension fixtures for the behavior-spelling compatibility
 * goldens (swamp-club#3338). Each fixture is an extension as an author keeps
 * it under `extensions/models/`: its manifest entries and its source files,
 * keyed by their path from the models directory. The shapes come from the
 * content extractor, catalog-gap and push tests, plus one multi-file model
 * extension (an entry point with helper imports, a nested entry point, an
 * `export const extension` add-on and an include file).
 *
 * The sources are strings, never modules: they are written to a temp repo
 * by the corpus and read back by the code under test.
 */

/** One extension fixture. */
export interface ExtensionFixture {
  /** Stable id, used as the golden key. */
  readonly id: string;
  /** `models:` manifest entries, relative to the models directory. */
  readonly models: readonly string[];
  /** `include:` manifest entries, relative to the models directory. */
  readonly include?: readonly string[];
  /** Every file of the extension, keyed by path from the models directory. */
  readonly files: Readonly<Record<string, string>>;
}

const lines = (...l: string[]): string => l.join("\n") + "\n";

export const EXTENSION_FIXTURES: readonly ExtensionFixture[] = [
  {
    id: "string-literal-type",
    models: ["ec2.ts"],
    files: {
      "ec2.ts": lines(
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "@acme/ec2",',
        '  version: "2026.03.01.1",',
        "  globalArguments: z.object({",
        '    region: z.string().describe("AWS region"),',
        "  }),",
        "  methods: {",
        "    start: {",
        '      description: "Start the instance",',
        "      arguments: z.object({ id: z.string() }),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "    stop: {",
        '      description: "Stop the instance",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ),
    },
  },
  {
    id: "modeltype-create",
    models: ["thing.ts"],
    files: {
      "thing.ts": lines(
        'import { z } from "npm:zod@4";',
        'import { ModelType } from "jsr:@swamp/types@0.1.0";',
        "export const model = {",
        '  type: ModelType.create("@acme/thing"),',
        '  version: "2026.03.01.1",',
        "  methods: {",
        "    run: {",
        '      description: "Run",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ),
    },
  },
  {
    id: "resources-files-upgrades",
    models: ["store.ts"],
    files: {
      "store.ts": lines(
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "@acme/store",',
        '  version: "2026.03.02.1",',
        "  resources: {",
        '    "result": {',
        '      description: "Execution result",',
        "      schema: z.object({}),",
        '      lifetime: "infinite",',
        "      garbageCollection: 10,",
        "    },",
        "  },",
        "  files: {",
        '    "log": {',
        '      description: "Run log",',
        '      contentType: "text/plain",',
        '      lifetime: "7d",',
        "      garbageCollection: 5,",
        "    },",
        "  },",
        "  upgrades: [",
        "    {",
        '      toVersion: "2026.03.02.1",',
        '      description: "Rename field",',
        "      upgradeAttributes: (old) => old,",
        "    },",
        "  ],",
        "  methods: {",
        "    run: {",
        '      description: "Run",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ),
    },
  },
  {
    id: "quoted-keys",
    models: ["subs.ts"],
    files: {
      "subs.ts": lines(
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "@acme/subs",',
        '  version: "2026.03.01.1",',
        "  methods: {",
        '    "list-subscriptions": {',
        '      description: "List",',
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "    'get-subscription': {",
        '      description: "Get",',
        '      arguments: z.object({ "sub-id": z.string() }),',
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ),
    },
  },
  {
    id: "type-in-string-before-export",
    models: ["prompt.ts"],
    files: {
      "prompt.ts": lines(
        'import { z } from "npm:zod@4";',
        'const PROMPT = `Reply with { type: "anime" }`;',
        "export const model = {",
        '  type: "@acme/prompt",',
        '  version: "2026.03.01.1",',
        "  methods: {",
        "    ask: {",
        "      description: PROMPT,",
        "      arguments: z.object({}),",
        "      execute: async () => ({ dataHandles: [] }),",
        "    },",
        "  },",
        "};",
      ),
    },
  },
  {
    id: "annotated-export",
    models: ["typed.ts"],
    files: {
      "typed.ts": lines(
        'import type { ModelDefinition } from "jsr:@swamp/types@0.1.0";',
        "export const model: ModelDefinition = {",
        '  type: "@acme/typed",',
        '  version: "2026.03.01.1",',
        "  methods: {},",
        "};",
      ),
    },
  },
  {
    id: "missing-version",
    models: ["noversion.ts"],
    files: {
      "noversion.ts": lines(
        "export const model = {",
        '  type: "@acme/noversion",',
        "  methods: {},",
        "};",
      ),
    },
  },
  {
    id: "wrapped-define",
    models: ["wrapped.ts"],
    files: {
      "wrapped.ts": lines(
        'import { defineModel } from "jsr:@swamp/testing@0.1.0";',
        "export const model = defineModel({",
        '  type: "@acme/wrapped",',
        '  version: "2026.03.01.1",',
        "  methods: {},",
        "});",
      ),
    },
  },
  {
    id: "multi-file",
    models: ["multi/model.ts", "aws/ec2/model.ts", "multi/extend.ts"],
    include: ["multi/data/regions.json"],
    files: {
      "multi/model.ts": lines(
        'import { z } from "npm:zod@4";',
        'import { methods } from "./lib/methods.ts";',
        'import { GlobalArgs } from "./lib/schemas.ts";',
        "export const model = {",
        '  type: "@acme/multi",',
        '  version: "2026.04.01.1",',
        "  globalArguments: GlobalArgs,",
        "  methods,",
        "};",
      ),
      "multi/lib/methods.ts": lines(
        'import { z } from "npm:zod@4";',
        'import { RunArgs } from "./schemas.ts";',
        "export const methods = {",
        "  sync: {",
        '    description: "Sync the multi resource",',
        "    arguments: RunArgs,",
        "    execute: async () => ({ dataHandles: [] }),",
        "  },",
        "  purge: {",
        '    description: "Purge old entries",',
        "    arguments: z.object({}),",
        "    execute: async () => ({ dataHandles: [] }),",
        "  },",
        "};",
      ),
      "multi/lib/schemas.ts": lines(
        'import { z } from "npm:zod@4";',
        "export const GlobalArgs = z.object({",
        '  endpoint: z.string().describe("Service endpoint"),',
        "});",
        "export const RunArgs = z.object({",
        "  dryRun: z.boolean().default(false),",
        "});",
      ),
      "multi/extend.ts": lines(
        'import { z } from "npm:zod@4";',
        "export const extension = {",
        '  type: "@acme/multi",',
        "  methods: [",
        "    {",
        "      audit: {",
        '        description: "Audit the multi resource",',
        "        arguments: z.object({}),",
        "        execute: async () => ({ dataHandles: [] }),",
        "      },",
        "    },",
        "  ],",
        "};",
      ),
      "multi/data/regions.json": '["us-east-1","eu-west-1"]\n',
      "aws/ec2/model.ts": lines(
        'import { z } from "npm:zod@4";',
        'import { tagsOf } from "./tags.ts";',
        "export const model = {",
        '  type: "@acme/aws/ec2",',
        '  version: "2026.04.01.1",',
        "  methods: {",
        "    tag: {",
        '      description: "Tag instances",',
        "      arguments: z.object({ name: z.string() }),",
        "      execute: async () => ({ dataHandles: [tagsOf()] }),",
        "    },",
        "  },",
        "};",
      ),
      "aws/ec2/tags.ts": lines(
        "export function tagsOf(): string {",
        '  return "tags";',
        "}",
      ),
    },
  },
];
