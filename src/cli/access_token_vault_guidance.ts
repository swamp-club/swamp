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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function tokenVaultRejectedMessage(
  operation: "mint" | "rotate",
  name: string,
  vaultName: string,
  opts: { remote?: boolean } = {},
): string {
  const action = operation === "mint" ? "minting" : "rotating";
  const location = opts.remote ? " on the serve host" : "";
  const rejection = opts.remote
    ? "--vault is not supported when targeting a remote server"
    : "--vault is not supported when a datastore is configured";
  const retry = opts.remote
    ? `The requested rotation was not performed. Rerun without --vault, then${location} copy the credential without printing it:`
    : `Rerun without --vault. After ${action}, copy the credential without printing it:`;
  const credentialKey = `server-token-${name}`;

  return `${rejection} - token secrets are stored in the control-plane vault. ${retry}\n` +
    `swamp access token reveal ${
      shellQuote(name)
    } --repo-dir <repo> --yes --json | jq -re .token | swamp vault put ${
      shellQuote(vaultName)
    } ${shellQuote(credentialKey)} --yes`;
}
