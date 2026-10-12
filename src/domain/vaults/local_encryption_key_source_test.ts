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
import {
  defaultLocalEncryptionConfig,
  findChangedKeySourceFields,
  findNonDefaultKeySourceFields,
  isLocalEncryptionType,
  serverDefaultKeySource,
  withRuntimeBaseDir,
  withServerDefaultKeySource,
} from "./local_encryption_key_source.ts";

Deno.test("isLocalEncryptionType: matches local_encryption in any case only", () => {
  assertEquals(isLocalEncryptionType("local_encryption"), true);
  assertEquals(isLocalEncryptionType("LOCAL_ENCRYPTION"), true);
  assertEquals(isLocalEncryptionType("Local_Encryption"), true);
  assertEquals(isLocalEncryptionType("local-encryption"), false);
  assertEquals(isLocalEncryptionType("mock"), false);
  assertEquals(isLocalEncryptionType("@swamp/aws-sm"), false);
});

Deno.test("serverDefaultKeySource: auto-generates the key under the repo", () => {
  assertEquals(serverDefaultKeySource("/repo"), {
    base_dir: "/repo",
    key_file: undefined,
    ssh_key_path: undefined,
    auto_generate: true,
  });
});

Deno.test("findChangedKeySourceFields: reports only key-source fields that differ", () => {
  const stored = { auto_generate: true, base_dir: "/repo", note: "a" };

  assertEquals(findChangedKeySourceFields({ ...stored }, stored), []);
  assertEquals(
    findChangedKeySourceFields({ ...stored, note: "b" }, stored),
    [],
  );
  assertEquals(
    findChangedKeySourceFields({ ...stored, base_dir: "/other" }, stored),
    ["base_dir"],
  );
  assertEquals(
    findChangedKeySourceFields({ base_dir: "/repo" }, stored),
    ["auto_generate"],
  );
  assertEquals(
    findChangedKeySourceFields(
      { ...stored, key_file: "/k", ssh_key_path: "~/.ssh/id_rsa" },
      stored,
    ),
    ["key_file", "ssh_key_path"],
  );
});

Deno.test("findChangedKeySourceFields: a non-primitive value counts as changed", () => {
  assertEquals(
    findChangedKeySourceFields({ base_dir: ["/repo"] }, { base_dir: "/repo" }),
    ["base_dir"],
  );
});

Deno.test("findChangedKeySourceFields: ignores inherited properties", () => {
  const inherited = Object.create({ base_dir: "/elsewhere" });
  assertEquals(findChangedKeySourceFields(inherited, {}), []);
});

Deno.test("findNonDefaultKeySourceFields: allows unset fields and the server defaults", () => {
  assertEquals(findNonDefaultKeySourceFields({}, "/repo"), []);
  assertEquals(
    findNonDefaultKeySourceFields(
      { base_dir: "/repo", auto_generate: true, note: "x" },
      "/repo",
    ),
    [],
  );
  assertEquals(
    findNonDefaultKeySourceFields(
      {
        base_dir: "/repo/../other",
        key_file: "/k",
        ssh_key_path: "~/.ssh/id_rsa",
        auto_generate: false,
      },
      "/repo",
    ),
    ["base_dir", "key_file", "ssh_key_path", "auto_generate"],
  );
});

Deno.test("withServerDefaultKeySource: replaces the key source and keeps other fields", () => {
  assertEquals(
    withServerDefaultKeySource(
      { note: "x", key_file: "/k", ssh_key_path: "/s", auto_generate: false },
    ),
    { note: "x", auto_generate: true },
  );
});

Deno.test("withServerDefaultKeySource: stores no base_dir, even the repo's own", () => {
  assertEquals(
    withServerDefaultKeySource({ base_dir: "/repo", auto_generate: true }),
    { auto_generate: true },
  );
});

Deno.test("defaultLocalEncryptionConfig: auto-generates the key and names no host path", () => {
  assertEquals(defaultLocalEncryptionConfig(), { auto_generate: true });
});

Deno.test("withRuntimeBaseDir: fills an unset or empty base_dir with the repo dir", () => {
  assertEquals(
    withRuntimeBaseDir("local_encryption", { auto_generate: true }, "/repo"),
    { auto_generate: true, base_dir: "/repo" },
  );
  assertEquals(
    withRuntimeBaseDir("local_encryption", { base_dir: "" }, "/repo"),
    { base_dir: "/repo" },
  );
});

Deno.test("withRuntimeBaseDir: matches the local_encryption type in any case", () => {
  assertEquals(
    withRuntimeBaseDir("LOCAL_ENCRYPTION", {}, "/repo"),
    { base_dir: "/repo" },
  );
  assertEquals(
    withRuntimeBaseDir("Local_Encryption", {}, "/repo"),
    { base_dir: "/repo" },
  );
});

Deno.test("withRuntimeBaseDir: keeps a stored base_dir and other types' config", () => {
  assertEquals(
    withRuntimeBaseDir("local_encryption", { base_dir: "/other" }, "/repo"),
    { base_dir: "/other" },
  );
  assertEquals(withRuntimeBaseDir("mock", {}, "/repo"), {});
  assertEquals(
    withRuntimeBaseDir("@swamp/aws-sm", { region: "eu-west-1" }, "/repo"),
    { region: "eu-west-1" },
  );
});
