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
import { join } from "@std/path";
import { readLocalManifestIdentity } from "./local_manifest_reader.ts";

async function withTempDir(
  fn: (dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_manifest_test_" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function writeManifest(repoRoot: string, content: string): void {
  const dir = join(repoRoot, "extensions");
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(join(dir, "manifest.yaml"), content);
}

Deno.test("readLocalManifestIdentity: valid manifest returns identity", async () => {
  await withTempDir((dir) => {
    writeManifest(
      dir,
      `manifestVersion: 1\nname: "@hivemq/terraform-harvester"\nversion: "2026.04.21.1"\n`,
    );
    assertEquals(readLocalManifestIdentity(dir), {
      name: "@hivemq/terraform-harvester",
      version: "2026.04.21.1",
    });
  });
});

Deno.test("readLocalManifestIdentity: missing file returns null silently", async () => {
  await withTempDir((dir) => {
    assertEquals(readLocalManifestIdentity(dir), null);
  });
});

Deno.test("readLocalManifestIdentity: malformed YAML returns null", async () => {
  await withTempDir((dir) => {
    writeManifest(dir, ":\n  - [invalid yaml {{{}}}");
    assertEquals(readLocalManifestIdentity(dir), null);
  });
});

Deno.test("readLocalManifestIdentity: name only (no version) returns null", async () => {
  await withTempDir((dir) => {
    writeManifest(dir, `name: "@scope/foo"\n`);
    assertEquals(readLocalManifestIdentity(dir), null);
  });
});

Deno.test("readLocalManifestIdentity: version only (no name) returns null", async () => {
  await withTempDir((dir) => {
    writeManifest(dir, `version: "1.0.0"\n`);
    assertEquals(readLocalManifestIdentity(dir), null);
  });
});

Deno.test("readLocalManifestIdentity: both missing returns null", async () => {
  await withTempDir((dir) => {
    writeManifest(dir, `manifestVersion: 1\nmodels:\n  - foo.ts\n`);
    assertEquals(readLocalManifestIdentity(dir), null);
  });
});

Deno.test("readLocalManifestIdentity: empty name string returns null", async () => {
  await withTempDir((dir) => {
    writeManifest(dir, `name: ""\nversion: "1.0.0"\n`);
    assertEquals(readLocalManifestIdentity(dir), null);
  });
});

Deno.test("readLocalManifestIdentity: empty version string returns null", async () => {
  await withTempDir((dir) => {
    writeManifest(dir, `name: "@scope/foo"\nversion: ""\n`);
    assertEquals(readLocalManifestIdentity(dir), null);
  });
});
