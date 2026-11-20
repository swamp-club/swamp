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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import { notFound } from "../../libswamp/errors.ts";
import { join } from "@std/path";
import { parseAppDescriptor } from "../../domain/apps/app_descriptor.ts";
import {
  appBuildWarnings,
  appCommand,
  completedData,
  inRepoCatalog,
} from "./app.ts";

Deno.test("appCommand: offers each operation", () => {
  assertEquals(
    appCommand.getCommands().map((command) => command.getName()).sort(),
    ["approve", "build", "dev", "init", "list", "revoke"],
  );
});

Deno.test("appCommand: approve and revoke can act on a server", () => {
  for (const name of ["approve", "list", "revoke"]) {
    const command = appCommand.getCommand(name);
    assertEquals(
      command?.getOptions().some((option) => option.name === "server"),
      true,
      name,
    );
  }
});

Deno.test("appBuildWarnings: an app.yaml without a platform is told the minor this swamp holds", () => {
  const [warning, ...rest] = appBuildWarnings(1, 4, false);
  assertEquals(rest, []);
  assertStringIncludes(warning, 'Add platform: "1.4" to app.yaml.');
  assertEquals(warning.includes("{"), false);
});

Deno.test("appBuildWarnings: a declared platform builds without a warning", () => {
  assertEquals(appBuildWarnings(1, 4, true), []);
});

Deno.test("appBuildWarnings: a swamp without the platform's build says so", () => {
  const warnings = appBuildWarnings(1, undefined, false);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "no build of app platform 1");
});

Deno.test("appCommand: approve takes --force as an alias for --yes", () => {
  const options = appCommand.getCommand("approve")?.getOptions() ?? [];
  const force = options.find((option) => option.name === "force");
  assertEquals(force?.flags, ["-f", "--force"]);
  assertStringIncludes(force?.description ?? "", "alias for --yes");
});

async function* events<T>(
  ...list: (
    | { kind: "completed"; data: T }
    | { kind: "error"; error: ReturnType<typeof notFound> }
  )[]
) {
  for (const event of list) yield event;
}

Deno.test("completedData: returns the completed event's data", async () => {
  assertEquals(
    await completedData(events({ kind: "completed", data: 1 }), "Enabling x"),
    1,
  );
});

Deno.test("completedData: a stream that ends without completing is an error", async () => {
  await assertRejects(
    () => completedData(events<number>(), "Enabling @acme/cost"),
    UserError,
    "Enabling @acme/cost did not complete.",
  );
});

Deno.test("completedData: a libswamp error keeps its code", async () => {
  const error = await assertRejects(
    () =>
      completedData(
        events<number>({ kind: "error", error: notFound("App", "@a/b") }),
        "Disabling @a/b",
      ),
    UserError,
  );
  assertEquals(error.code, "not_found");
});

Deno.test("inRepoCatalog: a repository opened through a symlink still finds its app", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const repo = join(dir, "repo");
    const app = join(repo, "apps", "cost");
    await Deno.mkdir(app, { recursive: true });
    await Deno.symlink(repo, join(dir, "linked"), { type: "dir" });
    const descriptor = parseAppDescriptor(
      `name: "@acme/cost"\ntitle: Cost\nbridge: 1\n`,
      "app.yaml",
    );
    const apps = [{ descriptor, origin: "local" as const, root: app }];
    const throughLink = join(dir, "linked", "apps", "cost");
    assertEquals(await inRepoCatalog(apps, "@acme/cost", throughLink), true);
    assertEquals(await inRepoCatalog(apps, "@acme/other", throughLink), false);
    assertEquals(
      await inRepoCatalog(
        [{ ...apps[0], origin: "extension" as const }],
        "@acme/cost",
        throughLink,
      ),
      false,
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
