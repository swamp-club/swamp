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
 * a rebuild of pulled extension source must read no Deno config from the
 * consumer's repo: with the noConfig flags its deno.json mapping never reaches
 * the pulled source, with a local extension's flags it does
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { denoProjectArgs } from "../src/domain/models/bundle.ts";
import { SHARED_SWAMP_DENO_CACHE } from "./test_helpers.ts";

const ENV = {
  DENO_DIR: SHARED_SWAMP_DENO_CACHE,
  NPM_CONFIG_REGISTRY: "http://127.0.0.1:1/",
};

const EVIL_MARKER = "consumer-config-reached-pulled-source";

async function withConsumerRepo(
  fn: (repoDir: string, source: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-pulled-no-config-" }),
  );
  try {
    await Deno.writeTextFile(
      join(repoDir, "deno.json"),
      JSON.stringify({ imports: { vecdep: "./evil.ts" } }),
    );
    await Deno.writeTextFile(
      join(repoDir, "evil.ts"),
      `export const value = "${EVIL_MARKER}";\n`,
    );
    const modelsDir = join(
      repoDir,
      ".swamp",
      "pulled-extensions",
      "@test",
      "pulled",
      "models",
    );
    await Deno.mkdir(modelsDir, { recursive: true });
    await Deno.writeTextFile(
      join(modelsDir, "helper.ts"),
      `export const helper = "helper";\n`,
    );
    const source = join(modelsDir, "m.ts");
    await Deno.writeTextFile(
      source,
      [
        `import { helper } from "./helper.ts";`,
        `import { value } from "vecdep";`,
        `export const model = { helper, value };`,
        "",
      ].join("\n"),
    );
    await fn(repoDir, source);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

async function bundleFrom(
  cwd: string,
  source: string,
  projectArgs: string[],
): Promise<{ success: boolean; js: string; output: string }> {
  const out = join(cwd, "out.js");
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      ...projectArgs,
      "--platform",
      "deno",
      "-o",
      out,
      source,
    ],
    cwd,
    env: ENV,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  const js = result.success ? await Deno.readTextFile(out) : "";
  return {
    success: result.success,
    js,
    output: decoder.decode(result.stderr) + decoder.decode(result.stdout),
  };
}

Deno.test("pulled rebuild: a consumer deno.json never resolves pulled source imports", async () => {
  await withConsumerRepo(async (repoDir, source) => {
    const args = denoProjectArgs({ noConfig: true });
    assertEquals(args[0], "--no-config");
    const pulled = await bundleFrom(repoDir, source, args);
    assert(
      !pulled.success,
      `the pulled rebuild resolved vecdep through the consumer's deno.json:\n${pulled.js}`,
    );
    assertStringIncludes(pulled.output, "vecdep");
  });
});

Deno.test("pulled rebuild: without noConfig the consumer deno.json applies, as for a local extension", async () => {
  await withConsumerRepo(async (repoDir, source) => {
    const local = await bundleFrom(repoDir, source, denoProjectArgs());
    assert(local.success, local.output);
    assertStringIncludes(local.js, EVIL_MARKER);
  });
});
