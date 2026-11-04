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

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { TarStream, type TarStreamInput } from "@std/tar/tar-stream";
import {
  AUTHORING_ARCHIVE,
  authoringFolders,
} from "../src/domain/apps/app_platform.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

interface PackedFile {
  readonly archivePath: string;
  readonly source: string;
  readonly size: number;
}

async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) found.push(...await filesUnder(path));
    else if (entry.isFile) found.push(path);
    else throw new Error(`${path} is neither a file nor a folder`);
  }
  return found;
}

// fixed metadata and sorted entries, so the same build packs to the same bytes
async function* tarInputs(
  files: readonly PackedFile[],
): AsyncGenerator<TarStreamInput> {
  for (const file of files) {
    // opened one at a time; a build holds more files than a process may open
    const handle = await Deno.open(file.source);
    yield {
      type: "file",
      path: file.archivePath,
      size: file.size,
      readable: handle.readable,
      options: { mode: 0o644, uid: 0, gid: 0, mtime: 0, uname: "", gname: "" },
    };
  }
}

/** One archive laid out as `.swamp-platform/`, hashed into `platform.json`, so a compiled swamp carries it compressed. */
export async function packAppPlatform(
  builtDir: string,
  major: number,
): Promise<void> {
  const folders = authoringFolders(major);
  for await (const entry of Deno.readDir(join(builtDir, "types"))) {
    if (!(`types/${entry.name}` in folders)) {
      throw new Error(`types/${entry.name} has no place in an app`);
    }
  }
  const files: PackedFile[] = [];
  for (const [from, to] of Object.entries(folders)) {
    for (const source of await filesUnder(join(builtDir, from))) {
      const rel = relative(join(builtDir, from), source).split(/[\\/]/);
      files.push({
        archivePath: [to, ...rel].join("/"),
        source,
        size: (await Deno.stat(source)).size,
      });
    }
  }
  files.sort((a, b) => a.archivePath < b.archivePath ? -1 : 1);

  const archive = join(builtDir, AUTHORING_ARCHIVE);
  const partial = `${archive}.partial`;
  const out = await Deno.open(partial, {
    write: true,
    create: true,
    truncate: true,
  });
  await ReadableStream.from(tarInputs(files))
    .pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream("gzip"))
    .pipeTo(out.writable);
  await Deno.rename(partial, archive);

  const manifestPath = join(builtDir, "platform.json");
  const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as {
    files?: Record<string, string>;
  };
  const hashes: Record<string, string> = {};
  for (const [path, hash] of Object.entries(manifest.files ?? {})) {
    if (!(path.startsWith("dev/") || path.startsWith("types/"))) {
      hashes[path] = hash;
    }
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(archive),
  );
  hashes[AUTHORING_ARCHIVE] = Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  manifest.files = Object.fromEntries(
    Object.entries(hashes).sort(([a], [b]) => a < b ? -1 : 1),
  );
  await Deno.writeTextFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  await Deno.remove(join(builtDir, "dev"), { recursive: true });
  await Deno.remove(join(builtDir, "types"), { recursive: true });
}

if (import.meta.main) {
  const major = Number(Deno.args[0] ?? "1");
  const builtDir = join(ROOT, "packages", "app-platform", "dist", String(major));
  await packAppPlatform(builtDir, major);
  const size = (await Deno.stat(join(builtDir, AUTHORING_ARCHIVE))).size;
  console.log(`Packed ${join(builtDir, AUTHORING_ARCHIVE)} (${size} bytes)`);
}
