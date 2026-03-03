// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { bold, dim, green, red, yellow } from "@std/fmt/colors";
import type { ApiKeyData } from "../../domain/auth/api_key.ts";
import type { OutputMode } from "./output.ts";

export function renderApiKeyList(
  keys: ApiKeyData[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(keys, null, 2));
  } else {
    if (keys.length === 0) {
      console.log("No API keys found.");
      return;
    }

    const header = `  ${bold("ID".padEnd(24))}  ${bold("Name".padEnd(20))}  ${
      bold("Status".padEnd(10))
    }  ${bold("Prefix".padEnd(14))}  ${bold("Created")}`;
    console.log(header);
    console.log(dim("  " + "─".repeat(90)));

    for (const key of keys) {
      const name = (key.name ?? dim("(unnamed)")).slice(0, 20).padEnd(20);
      const status = key.enabled
        ? green("active".padEnd(10))
        : red("revoked".padEnd(10));
      const prefix = (key.start || key.prefix).padEnd(14);
      const created = key.createdAt.slice(0, 10);
      console.log(
        `  ${key.id.padEnd(24)}  ${name}  ${status}  ${prefix}  ${created}`,
      );
    }
  }
}

export interface ApiKeyCreateResult {
  id: string;
  key: string;
  name: string;
}

export function renderApiKeyCreate(
  data: ApiKeyCreateResult,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log("");
    console.log(`  ${green("✔")} ${bold("API key created")}`);
    console.log("");
    if (data.name) {
      console.log(`  ${bold("Name:")}  ${data.name}`);
    }
    console.log(`  ${bold("ID:")}    ${data.id}`);
    console.log(`  ${bold("Key:")}   ${data.key}`);
    console.log("");
    console.log(
      `  ${yellow("⚠")} ${
        bold("Store this key securely — it will not be shown again.")
      }`,
    );
  }
}

export function renderApiKeyRevoke(
  keyId: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ revoked: true, keyId }, null, 2));
  } else {
    console.log(`${green("✔")} API key ${bold(keyId)} has been revoked.`);
  }
}

export function renderApiKeyDelete(
  keyId: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ deleted: true, keyId }, null, 2));
  } else {
    console.log(`${green("✔")} API key ${bold(keyId)} has been deleted.`);
  }
}
