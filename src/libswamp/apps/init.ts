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

import { dirname, join, relative } from "@std/path";
import { ensureDir, exists, walk } from "@std/fs";
import { AppNameSchema } from "../../domain/apps/app_descriptor.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { resourcePath } from "../../infrastructure/runtime/resource_root.ts";
import type { LibSwampContext } from "../context.ts";
import { writeAppPlatform } from "./platform_files.ts";
import { type SwampError, validationFailed } from "../errors.ts";

// embedded in the compiled binary, so located from the resource root
const PACKAGES_DIR = resourcePath("packages");

export const APP_TEMPLATES = ["dashboard", "gallery"] as const;
export type AppTemplate = typeof APP_TEMPLATES[number];

export interface AppInitInput {
  readonly name: string;
  readonly title?: string;
  readonly directory: string;
  readonly template: AppTemplate;
}

export interface AppInitData {
  readonly name: string;
  readonly directory: string;
  readonly template: AppTemplate;
  /** The platform written into `app.yaml`: this swamp's major.minor. */
  readonly platform: string;
}

export type AppInitEvent =
  | { kind: "completed"; data: AppInitData }
  | { kind: "error"; error: SwampError };

function titleOf(name: string): string {
  const last = name.split("/").pop() ?? name;
  return last.split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

interface Fills {
  readonly name: string;
  readonly title: string;
  readonly platform: string;
}

/** JSON is valid YAML, so a quote in a title cannot break `app.yaml`. */
function fill(text: string, { name, title, platform }: Fills): string {
  return text.replaceAll("{{name}}", name)
    .replaceAll("{{titleYaml}}", JSON.stringify(title))
    .replaceAll("{{title}}", escapeHtml(title))
    .replaceAll("{{platform}}", platform);
}

async function copyTemplate(
  from: string,
  to: string,
  fills: Fills,
): Promise<void> {
  for await (const entry of walk(from, { includeDirs: false })) {
    const target = join(to, relative(from, entry.path));
    await ensureDir(dirname(target));
    await Deno.writeTextFile(
      target,
      fill(await Deno.readTextFile(entry.path), fills),
    );
  }
}

export async function* appInit(
  _ctx: LibSwampContext,
  input: AppInitInput,
): AsyncIterable<AppInitEvent> {
  yield* withGeneratorSpan(
    "swamp.app.init",
    { "app.name": input.name },
    (async function* (): AsyncGenerator<AppInitEvent> {
      const name = AppNameSchema.safeParse(input.name);
      if (!name.success) {
        yield {
          kind: "error",
          error: validationFailed(name.error.issues[0].message),
        };
        return;
      }
      const title = input.title ?? titleOf(input.name);
      if (title.length === 0 || title.length > 100) {
        yield {
          kind: "error",
          error: validationFailed("A title is 1 to 100 characters."),
        };
        return;
      }
      if (await exists(input.directory)) {
        yield {
          kind: "error",
          error: validationFailed(`${input.directory} already exists.`),
        };
        return;
      }
      // a new app asks for the minor this swamp holds, so it may use all of it
      const held = await writeAppPlatform(input.directory, 1);
      const platform = held.minor === undefined
        ? String(held.major)
        : `${held.major}.${held.minor}`;
      const fills = { name: input.name, title, platform };
      const templates = join(PACKAGES_DIR, "app-sdk", "templates");
      await copyTemplate(join(templates, "base"), input.directory, fills);
      await copyTemplate(
        join(templates, input.template),
        input.directory,
        fills,
      );
      yield {
        kind: "completed",
        data: {
          name: input.name,
          directory: input.directory,
          template: input.template,
          platform,
        },
      };
    })(),
  );
}
