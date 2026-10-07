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
import type { VaultConfigField } from "../domain/vaults/vault_config_fields.ts";
import {
  canPromptForConfig,
  type ConfigPromptIO,
  promptForMissingConfigFields,
} from "./vault_config_prompt.ts";

const TYPE = "@swamp/1password";

const FIELDS: VaultConfigField[] = [
  {
    name: "op_vault",
    type: "string",
    description: "The 1Password vault to use",
    required: true,
  },
  { name: "op_account", type: "string", required: false },
  { name: "retries", type: "number", required: true },
  { name: "token", type: "string", required: true },
];

function scriptedIO(answers: Record<string, string>) {
  const asked: string[] = [];
  const askedHidden: string[] = [];
  const notes: string[] = [];
  const answer = (message: string) => {
    const name = message.split(" ")[0].replace(/:$/, "");
    return Promise.resolve(answers[name] ?? "");
  };
  const io: ConfigPromptIO = {
    prompt: (message) => {
      asked.push(message);
      return answer(message);
    },
    promptSecret: (message) => {
      askedHidden.push(message);
      return answer(message);
    },
    note: (line) => {
      notes.push(line);
      return Promise.resolve();
    },
  };
  return { asked, askedHidden, notes, io };
}

Deno.test("promptForMissingConfigFields: explains why, asks for each missing required string field, and hides a credential-shaped one", async () => {
  const { asked, askedHidden, notes, io } = scriptedIO({
    op_vault: "Private",
    token: "t",
  });

  const answers = await promptForMissingConfigFields(TYPE, FIELDS, {}, io);

  assertEquals(notes, [
    "@swamp/1password needs these config fields. Press Enter to leave one unset.",
    "Pass with --config: retries (number).",
    "Note: token is saved as plain text in the vault's config file, which is tracked in git.",
  ]);
  assertEquals(asked, ["op_vault (The 1Password vault to use): "]);
  assertEquals(askedHidden, ["token (input hidden): "]);
  assertEquals(answers, { op_vault: "Private", token: "t" });
});

Deno.test("promptForMissingConfigFields: a described credential field says both things", async () => {
  const { askedHidden, io } = scriptedIO({ secretKey: "s" });

  const answers = await promptForMissingConfigFields(
    "@acme/vault",
    [{
      name: "secretKey",
      type: "string",
      description: "Scaleway API secret key",
      required: true,
    }],
    {},
    io,
  );

  assertEquals(askedHidden, [
    "secretKey (Scaleway API secret key; input hidden): ",
  ]);
  assertEquals(answers, { secretKey: "s" });
});

Deno.test("promptForMissingConfigFields: an empty hidden answer gets no note", async () => {
  const { notes, io } = scriptedIO({});

  const answers = await promptForMissingConfigFields(
    "@acme/vault",
    [{ name: "token", type: "string", required: true }],
    {},
    io,
  );

  assertEquals(answers, {});
  assertEquals(notes, [
    "@acme/vault needs these config fields. Press Enter to leave one unset.",
  ]);
});

Deno.test("promptForMissingConfigFields: skips fields the config already has", async () => {
  const { asked, notes, io } = scriptedIO({ token: "t" });

  const answers = await promptForMissingConfigFields(
    TYPE,
    FIELDS,
    { op_vault: "Private", retries: 2 },
    io,
  );

  assertEquals(notes.length, 2);
  assertEquals(asked, []);
  assertEquals(answers, { token: "t" });
});

Deno.test("promptForMissingConfigFields: leaves an empty answer out so the schema reports it", async () => {
  const { io } = scriptedIO({ token: "t" });

  const answers = await promptForMissingConfigFields(TYPE, FIELDS, {}, io);

  assertEquals(answers, { token: "t" });
});

Deno.test("promptForMissingConfigFields: says nothing when nothing is missing", async () => {
  const { asked, notes, io } = scriptedIO({});

  const answers = await promptForMissingConfigFields(
    TYPE,
    FIELDS,
    { op_vault: "v", retries: 1, token: "t" },
    io,
  );

  assertEquals(notes, []);
  assertEquals(asked, []);
  assertEquals(answers, {});
});

Deno.test("promptForMissingConfigFields: only names non-string fields when none can be asked for", async () => {
  const { asked, notes, io } = scriptedIO({});

  const answers = await promptForMissingConfigFields(
    TYPE,
    FIELDS,
    { op_vault: "v", token: "t" },
    io,
  );

  assertEquals(notes, ["Pass with --config: retries (number)."]);
  assertEquals(asked, []);
  assertEquals(answers, {});
});

Deno.test("canPromptForConfig: only in log mode without --yes and with a terminal stdin", () => {
  const original = Deno.stdin.isTerminal;
  try {
    Deno.stdin.isTerminal = () => true;
    assertEquals(canPromptForConfig("log"), true);
    assertEquals(canPromptForConfig("log", { yes: true }), false);
    assertEquals(canPromptForConfig("json"), false);
    Deno.stdin.isTerminal = () => false;
    assertEquals(canPromptForConfig("log"), false);
    Deno.stdin.isTerminal = () => {
      throw new Error("no stdin");
    };
    assertEquals(canPromptForConfig("log"), false);
  } finally {
    Deno.stdin.isTerminal = original;
  }
});
