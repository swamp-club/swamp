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
 * Fills `~/.config/swamp/verify.env` from 1Password.
 *
 * The verification workflows need credentials that nothing in this repository
 * can supply. Setting them up has been a paragraph of documentation and a
 * heredoc, which is why a machine can sit for weeks with
 * `TESSL_TOKEN=replace-me-from-1p-value` in place of a token and only discover
 * it when `skill-review` exits 1 partway through a run.
 *
 * One item per variable, titled by the variable's own name, so nothing here
 * names a vault, an item path or a team. That matters: this repository is
 * public, and a script that hardcoded `op://SomeTeamVault/...` would publish
 * an internal detail just as surely as committing a config file would.
 *
 * Deliberately generates a file rather than resolving secrets at run time. A
 * workflow that reached for 1Password mid-run would hit the unlock prompt
 * inside a step, where there is nowhere for a prompt to go. Writing the file
 * keeps the unlock at a moment you chose.
 *
 * Usage:
 *   deno run setup-verify-env [--account <name>] [--check]
 *
 * `--check` reports what is missing and writes nothing, which is worth running
 * before a verification rather than discovering a gap several minutes in.
 */

import { parseArgs } from "@std/cli/parse-args";
import { dirname, join } from "@std/path";

/**
 * The variables the verification workflows read, and what their absence costs.
 *
 * The distinction is the point. A missing `TESSL_TOKEN` fails loudly and stops
 * the run. A missing `ANTHROPIC_API_KEY` is quieter and worse: trigger evals
 * skip at exit 0 and the reviews fall back to a claude.ai login, so the gate
 * goes green having checked less than it looks like it checked.
 */
export const VERIFY_KEYS: ReadonlyArray<{
  name: string;
  required: boolean;
  consequence: string;
}> = [
  {
    name: "TESSL_TOKEN",
    required: true,
    consequence:
      "skill-review exits 1, so verification cannot complete on a branch " +
      "that touches skill files",
  },
  {
    name: "ANTHROPIC_API_KEY",
    required: false,
    consequence:
      "trigger evals skip at exit 0 and reviews fall back to the claude.ai " +
      "login — the gate still goes green, having checked less",
  },
];

// -- 1Password item shape (the subset this reads) ---------------------------

interface OpField {
  id?: string;
  label?: string;
  type?: string;
  purpose?: string;
  value?: string;
}

export interface OpItem {
  title?: string;
  category?: string;
  fields?: OpField[];
}

/**
 * The secret out of a 1Password item, whatever shape the item is.
 *
 * An API Credential keeps it in `credential`, a Login or Password item in
 * `password`, and a custom item in a concealed field of its own naming. Trying
 * them in order beats requiring everyone's items to be the same category,
 * which is the sort of constraint that turns a setup script into a second
 * setup task.
 */
export function selectSecretValue(item: OpItem): string | null {
  const fields = item.fields ?? [];
  const byId = (id: string) =>
    fields.find((f) => f.id === id && typeof f.value === "string" && f.value);

  const credential = byId("credential") ?? byId("password");
  if (credential?.value) return credential.value;

  const byPurpose = fields.find((f) =>
    f.purpose === "PASSWORD" && typeof f.value === "string" && f.value
  );
  if (byPurpose?.value) return byPurpose.value;

  const concealed = fields.find((f) =>
    f.type === "CONCEALED" && typeof f.value === "string" && f.value
  );
  return concealed?.value ?? null;
}

/**
 * Renders the env file, replacing what we fetched and keeping everything else.
 *
 * Keys this script does not manage are preserved verbatim, comments included.
 * The file is a hand-edited dotfile on someone's machine; a setup helper that
 * silently dropped a line somebody added is a worse failure than not running
 * at all.
 */
export function renderEnvFile(
  existing: string,
  updates: ReadonlyMap<string, string>,
): string {
  const applied = new Set<string>();
  const lines = existing.length > 0 ? existing.split("\n") : [];

  const rendered = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) return line;
    const key = match[1];
    const value = updates.get(key);
    if (value === undefined) return line;
    applied.add(key);
    return `${key}=${quote(value)}`;
  });

  // Drop a trailing empty line so appended keys do not land after a blank.
  while (rendered.length > 0 && rendered[rendered.length - 1].trim() === "") {
    rendered.pop();
  }

  for (const [key, value] of updates) {
    if (!applied.has(key)) rendered.push(`${key}=${quote(value)}`);
  }

  return rendered.join("\n") + "\n";
}

/**
 * Single-quoted so the file survives `.` in a shell regardless of what the
 * token contains. The documented format was bare `KEY=value`, which works
 * until a credential contains a space or a `$`.
 */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// -- I/O shell ---------------------------------------------------------------

/** The path the conventions doc names, honouring XDG and HOME. */
export function verifyEnvPath(env: {
  XDG_CONFIG_HOME?: string;
  HOME?: string;
}): string | null {
  const base = env.XDG_CONFIG_HOME ??
    (env.HOME ? join(env.HOME, ".config") : undefined);
  return base ? join(base, "swamp", "verify.env") : null;
}

interface OpAccount {
  url?: string;
  email?: string;
  account_uuid?: string;
}

async function opAccounts(): Promise<OpAccount[]> {
  try {
    const { code, stdout } = await new Deno.Command("op", {
      args: ["account", "list", "--format", "json"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (code !== 0) return [];
    return JSON.parse(new TextDecoder().decode(stdout)) as OpAccount[];
  } catch {
    return [];
  }
}

/**
 * Reads one item, letting `op` own the terminal.
 *
 * stdin and stderr are inherited rather than piped, because unlocking is
 * interactive: piping them leaves `op` waiting for input nobody can give and
 * the script hanging with no output. Only stdout is captured, since that is
 * the JSON.
 */
async function opItemGet(
  title: string,
  account: string | undefined,
): Promise<OpItem | null> {
  const args = ["item", "get", title, "--format", "json"];
  if (account) args.push("--account", account);
  try {
    const { code, stdout } = await new Deno.Command("op", {
      args,
      stdout: "piped",
      stderr: "inherit",
      stdin: "inherit",
    }).output();
    if (code !== 0) return null;
    return JSON.parse(new TextDecoder().decode(stdout)) as OpItem;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args, {
    string: ["account"],
    boolean: ["check"],
  });

  const path = verifyEnvPath(Deno.env.toObject());
  if (!path) {
    console.error("cannot locate a config directory: set HOME or XDG_CONFIG_HOME");
    return 1;
  }

  if (!(await commandExists("op"))) {
    console.error(
      "the 1Password CLI (`op`) is not on PATH.\n" +
        "  install: https://developer.1password.com/docs/cli/get-started/",
    );
    return 1;
  }

  // Resolved before any item is read. `op` refuses with "multiple accounts
  // found" when more than one is signed in, and that error arrives per item
  // rather than once, which reads like the items are missing.
  let account = args.account ?? Deno.env.get("OP_ACCOUNT");
  if (!account) {
    const accounts = await opAccounts();
    if (accounts.length === 1) {
      account = accounts[0].url ?? accounts[0].account_uuid;
    } else if (accounts.length > 1) {
      console.error(
        "more than one 1Password account is signed in; name the one holding " +
          "these items with --account or OP_ACCOUNT:",
      );
      for (const a of accounts) {
        console.error(`  ${a.url ?? a.account_uuid} (${a.email ?? "?"})`);
      }
      return 1;
    }
  }

  console.error(
    `reading ${VERIFY_KEYS.length} item(s) from 1Password${
      account ? ` (account: ${account})` : ""
    }`,
  );

  const updates = new Map<string, string>();
  const missing: string[] = [];
  for (const key of VERIFY_KEYS) {
    const item = await opItemGet(key.name, account);
    const value = item ? selectSecretValue(item) : null;
    if (!value) {
      missing.push(key.name);
      console.error(
        `  ${key.name.padEnd(20)} MISSING — ${
          key.required ? "required" : "optional"
        }: ${key.consequence}`,
      );
      continue;
    }
    updates.set(key.name, value);
    console.error(`  ${key.name.padEnd(20)} ok`);
  }

  const required = VERIFY_KEYS.filter((k) =>
    k.required && missing.includes(k.name)
  );
  if (required.length > 0) {
    console.error(
      `\ncould not read ${
        required.map((k) => k.name).join(", ")
      } — create an item with that exact title in 1Password`,
    );
    return 1;
  }

  if (args.check) {
    console.error(
      `\n--check: nothing written. ${updates.size} of ${VERIFY_KEYS.length} ` +
        "key(s) available.",
    );
    return 0;
  }

  let existing = "";
  try {
    existing = await Deno.readTextFile(path);
  } catch {
    await Deno.mkdir(dirname(path), { recursive: true });
  }

  await Deno.writeTextFile(path, renderEnvFile(existing, updates));
  // writeTextFile's mode applies only on creation, so an existing file keeps
  // whatever permissions it had. Setting it every time is the only way the
  // guarantee holds on the second run.
  await Deno.chmod(path, 0o600);

  console.error(`\nwrote ${path} (0600, ${updates.size} key(s))`);
  // The file is not read by anything: the conventions doc says to export it
  // before running the workflow, and the shell model passes the swamp
  // process's own environment to each step. Writing it without saying so
  // leaves someone wondering why skill-review still fails.
  console.error(
    "\nnothing reads this file automatically — export it in the shell that " +
      "runs verification:\n" +
      `  set -a; . ${path}; set +a`,
  );
  return 0;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    const { code } = await new Deno.Command(command, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return code === 0;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
