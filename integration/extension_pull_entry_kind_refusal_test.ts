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
 * Pull installs only regular files and directories from an extension
 * archive (swamp-club#3496). Push never writes anything else, so these
 * archives can only be hand-built and uploaded outside swamp; that is the
 * case this covers. Wires the CLI's pull path (`pullExtension` over
 * `createExtensionPullDeps` and the real registry client) to a registry
 * on a port-0 server, and renders the failure as the CLI does in log and
 * JSON modes.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, parse } from "@std/path";
import { walk } from "@std/fs";
import { getLogger } from "@logtape/logtape";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { pullExtension } from "../src/cli/commands/extension_pull.ts";
import { createExtensionPullDeps } from "../src/libswamp/extensions/pull.ts";
import {
  exitCodeForError,
  renderError,
} from "../src/presentation/output/error_output.ts";
import { computeChecksum } from "../src/domain/models/checksum.ts";
import { UserError } from "../src/domain/errors.ts";
import {
  buildRawTarGz,
  type RawTarEntry,
} from "../src/infrastructure/archive/raw_tar_test_helpers.ts";

await initializeLogging({});

const VERSION = "2026.10.26.1";
const ESC = "\x1b";
const LINK_TARGET_MARK = "link-target-must-not-print";
const ABSOLUTE_TARGET = join(
  parse(Deno.cwd()).root,
  `${LINK_TARGET_MARK}-${crypto.randomUUID()}`,
);

/** A registry serving `archive` as the only version of `name`. */
async function serveRegistry(name: string, archive: Uint8Array<ArrayBuffer>) {
  const checksum = await computeChecksum(archive);
  const encoded = encodeURIComponent(name);
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    (req) => {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      if (path === `/api/v1/extensions/${name}`) {
        return Response.json({ name, description: "", latestVersion: VERSION });
      }
      if (path === `/api/v1/extensions/${name}/latest`) {
        return Response.json({ latestVersion: VERSION });
      }
      if (path === `/api/v1/extensions/${name}@${VERSION}/download`) {
        return new Response(null, {
          status: 302,
          headers: { location: `${url.origin}/archive/${encoded}` },
        });
      }
      if (path === `/archive/${name}`) return new Response(archive);
      if (path === `/api/v1/extensions/${name}@${VERSION}/checksum`) {
        return Response.json({ checksum });
      }
      return new Response(null, { status: 404 });
    },
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    async [Symbol.asyncDispose]() {
      await server.shutdown();
    },
  };
}

/** A skill-only extension archive whose last entry is `extra`. */
async function archiveWith(name: string, extra: RawTarEntry) {
  const skill = `skill-${name.split("/").pop()}`;
  return await buildRawTarGz([
    { path: "extension/", typeflag: "5" },
    {
      path: "extension/manifest.yaml",
      typeflag: "0",
      body: [
        "manifestVersion: 1",
        `name: "${name}"`,
        `version: "${VERSION}"`,
        "skills:",
        `  - ${skill}`,
      ].join("\n"),
    },
    { path: `extension/skills/${skill}/SKILL.md`, typeflag: "0", body: name },
    extra,
  ]);
}

function captureStderr(run: () => void): string {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

/** Every path under `dir`, symlinks included and never followed. */
async function treeOf(dir: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of walk(dir, { followSymlinks: false })) {
    paths.push(entry.path);
  }
  return paths.sort();
}

interface Case {
  what: string;
  entry: () => RawTarEntry;
  /** What the error prints for the entry, after its archive path. */
  printed: string;
}

const CASES: Case[] = [
  {
    what: "a symlink inside the extension",
    entry: () => ({
      path: "extension/files/inside",
      typeflag: "2",
      linkname: `manifest.yaml#${LINK_TARGET_MARK}`,
    }),
    printed:
      "extension/files/inside is a symlink; extensions may not contain links",
  },
  {
    what: "a symlink to an absolute path outside the repository",
    // At the file system root, so the target fits the header's 100-byte
    // linkname field wherever the temp dir is.
    entry: () => ({
      path: "extension/files/escape",
      typeflag: "2",
      linkname: ABSOLUTE_TARGET,
    }),
    printed:
      "extension/files/escape is a symlink; extensions may not contain links",
  },
  {
    what: "a symlink climbing out of the extension",
    entry: () => ({
      path: "extension/files/climb",
      typeflag: "2",
      linkname: `../../../../../../${LINK_TARGET_MARK}`,
    }),
    printed:
      "extension/files/climb is a symlink; extensions may not contain links",
  },
  {
    what: "a hardlink",
    entry: () => ({
      path: "extension/files/hard",
      typeflag: "1",
      linkname: `extension/${LINK_TARGET_MARK}`,
    }),
    printed:
      "extension/files/hard is a hardlink; extensions may not contain links",
  },
  {
    what: "a FIFO",
    entry: () => ({ path: "extension/files/fifo", typeflag: "6" }),
    printed: "extension/files/fifo is a FIFO; an extension holds only " +
      "regular files and directories",
  },
  {
    what: "a character device",
    entry: () => ({ path: "extension/files/chr", typeflag: "3" }),
    printed: "extension/files/chr is a character device; an extension " +
      "holds only regular files and directories",
  },
  {
    what: "a block device",
    entry: () => ({ path: "extension/files/blk", typeflag: "4" }),
    printed: "extension/files/blk is a block device; an extension holds " +
      "only regular files and directories",
  },
  {
    what: "an unknown typeflag carrying a body",
    entry: () => ({
      path: "extension/files/odd.ts",
      typeflag: "Z",
      body: "export const z = 1;\n",
    }),
    printed: "extension/files/odd.ts has an unsupported tar entry type; an " +
      "extension holds only regular files and directories",
  },
  {
    what: "a symlink whose path holds an ESC sequence",
    entry: () => ({
      path: `extension/files/${ESC}[31mred`,
      typeflag: "2",
      linkname: LINK_TARGET_MARK,
    }),
    printed: "extension/files/\\x1b[31mred is a symlink; extensions may " +
      "not contain links",
  },
];

for (const { what, entry, printed } of CASES) {
  for (const outputMode of ["log", "json"] as const) {
    Deno.test(`extension pull (${outputMode}): ${what} refuses the archive and writes nothing (swamp-club#3496)`, async () => {
      const root = await Deno.realPath(
        await Deno.makeTempDir({ prefix: "swamp-pull-entry-kind-" }),
      );
      try {
        const repoDir = join(root, "repo");
        const outside = join(root, "outside");
        await Deno.mkdir(repoDir);
        await Deno.mkdir(outside);
        const before = await treeOf(root);

        const name = `@test/entry-kind-${crypto.randomUUID().slice(0, 8)}`;
        await using registry = await serveRegistry(
          name,
          await archiveWith(name, entry()),
        );
        const lockfilePath = join(repoDir, "upstream_extensions.json");
        const deps = await createExtensionPullDeps(
          registry.url,
          lockfilePath,
          [join(repoDir, ".claude", "skills")],
          repoDir,
        );

        let thrown: unknown;
        try {
          await pullExtension({ name, version: null }, {
            ...deps,
            logger: getLogger(["test"]),
            skillsDirs: [join(repoDir, ".claude", "skills")],
            repoDir,
            force: false,
            outputMode,
            alreadyPulled: new Set(),
            depth: 0,
          });
        } catch (error) {
          thrown = error;
        }
        assert(thrown instanceof UserError, String(thrown));
        assertEquals(exitCodeForError(thrown), 1);

        const stderr = captureStderr(() => renderError(thrown, outputMode));
        const message = outputMode === "json"
          ? JSON.parse(stderr).error as string
          : stderr;
        assertStringIncludes(
          message,
          `Extension archive ${name}@${VERSION} cannot be installed: ${printed}`,
        );
        assertEquals(stderr.includes(LINK_TARGET_MARK), false, stderr);
        // Log mode colours "Error:" with its own escapes; the entry's raw
        // sequence must not reach the terminal.
        assertEquals(stderr.includes(`${ESC}[31mred`), false, stderr);

        // Nothing landed: no install root, no lockfile entry, and the
        // tree around the repository is as it was.
        const lockfile = await Deno.readTextFile(lockfilePath).catch(() => "");
        assertEquals(lockfile.includes(name), false, lockfile);
        assertEquals(await Deno.lstat(ABSOLUTE_TARGET).catch(() => null), null);
        assertEquals(
          (await treeOf(root)).filter((p) =>
            p.includes("pulled-extensions") || !p.startsWith(repoDir)
          ),
          before.filter((p) => !p.startsWith(repoDir)),
        );
      } finally {
        await Deno.remove(root, { recursive: true }).catch((error) => {
          if (Deno.build.os !== "windows") throw error;
        });
      }
    });
  }
}
