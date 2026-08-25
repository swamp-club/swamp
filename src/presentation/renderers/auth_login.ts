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

import { bold, cyan, dim, green, yellow } from "@std/fmt/colors";
import type {
  AuthLoginData,
  AuthLoginEvent,
  EventHandlers,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { Spinner } from "../spinner.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

// ─── Card rendering helpers ───────────────────────────────────────────

interface CardRow {
  label: string;
  value: string;
}

/** Strip ANSI escape codes to get visible character length. */
function stripAnsi(str: string): string {
  // deno-lint-ignore no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Mask an API key, showing prefix and last 4 chars. */
function maskApiKey(key: string): string {
  if (key.length <= 16) return key.slice(0, 8) + dim("•••");
  return key.slice(0, 12) + dim("•••") + key.slice(-4);
}

/**
 * Render a box-drawn card with a header and grouped rows.
 * Uses double-line box drawing for the outer frame and a
 * single-line divider between header and body.
 */
function renderCard(
  header: string,
  groups: CardRow[][],
): string[] {
  const allRows = groups.flat();
  const labelWidth = Math.max(...allRows.map((r) => r.label.length));
  const rawValueWidth = Math.max(
    ...allRows.map((r) => stripAnsi(r.value).length),
  );
  const headerTextWidth = stripAnsi(header).length;
  const rowInnerWidth = 2 + labelWidth + 3 + rawValueWidth + 2;
  const contentWidth = Math.max(rowInnerWidth, headerTextWidth + 4);

  const lines: string[] = [];

  // Top border
  lines.push(green(`  ╔${"═".repeat(contentWidth)}╗`));

  // Header
  const headerPad = " ".repeat(contentWidth - headerTextWidth - 2);
  lines.push(
    green("  ║") + `  ${header}${headerPad}` + green("║"),
  );

  // Divider
  lines.push(green(`  ╠${"═".repeat(contentWidth)}╣`));

  // Body groups
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];

    // Spacer before each group
    lines.push(green("  ║") + " ".repeat(contentWidth) + green("║"));

    for (const row of group) {
      const paddedLabel = row.label.padEnd(labelWidth);
      const visibleValueLen = stripAnsi(row.value).length;
      const valuePad = " ".repeat(rawValueWidth - visibleValueLen);
      const extraPad = " ".repeat(contentWidth - rowInnerWidth);
      lines.push(
        green("  ║") + "  " + bold(cyan(paddedLabel)) + "   " +
          row.value +
          valuePad + extraPad + "  " + green("║"),
      );
    }

    // Spacer after last group
    if (gi === groups.length - 1) {
      lines.push(
        green("  ║") + " ".repeat(contentWidth) + green("║"),
      );
    }
  }

  // Bottom border
  lines.push(green(`  ╚${"═".repeat(contentWidth)}╝`));

  return lines;
}

function renderDeviceVerification(
  userCode: string,
  verificationUri: string,
  verificationUriComplete?: string,
): void {
  const url = verificationUriComplete ?? verificationUri;
  const lines = renderCard(
    bold("Verify your device"),
    [[
      { label: "Code", value: bold(yellow(userCode)) },
      { label: "URL", value: url },
    ]],
  );
  lines.push("");
  lines.push(
    "  Open the URL above and enter the code to sign in.",
  );

  writeOutput(lines.join("\n"));
}

function renderAuthLoginSuccess(data: AuthLoginData): void {
  // Identity rows
  const identity: CardRow[] = [
    { label: "User", value: bold(`@${data.username}`) },
  ];
  if (data.name) {
    identity.push({ label: "Name", value: data.name });
  }
  if (data.email) {
    identity.push({ label: "Email", value: data.email });
  }

  // Session rows
  const session: CardRow[] = [
    { label: "Server", value: data.serverUrl },
    { label: "Key", value: maskApiKey(data.apiKey) },
  ];

  const lines = renderCard(
    `${green("✔")} ${bold("Authenticated")}`,
    [identity, session],
  );

  writeOutput(lines.join("\n"));
}

// ─── Renderers ────────────────────────────────────────────────────────

class LogAuthLoginRenderer implements Renderer<AuthLoginEvent> {
  private spinner: Spinner | null = null;
  private pollingSpinnerStarted = false;

  constructor(private showSpinner: boolean) {}

  handlers(): EventHandlers<AuthLoginEvent> {
    return {
      device_verification: (e) => {
        this.spinner?.stop();
        renderDeviceVerification(
          e.userCode,
          e.verificationUri,
          e.verificationUriComplete,
        );
        console.log();
      },
      opening_browser: () => {},
      browser_open_failed: (e) => {
        console.log(yellow(e.message));
      },
      polling: () => {
        if (this.showSpinner && !this.pollingSpinnerStarted) {
          this.pollingSpinnerStarted = true;
          this.spinner = new Spinner();
          this.spinner.start("Waiting for authentication...");
        }
      },
      securing_session: () => {
        if (this.spinner) {
          this.spinner.update("Securing session...");
        }
      },
      completed: (e) => {
        this.spinner?.stop();
        renderAuthLoginSuccess(e.data);
      },
      error: (e) => {
        this.spinner?.stop();
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonAuthLoginRenderer implements Renderer<AuthLoginEvent> {
  handlers(): EventHandlers<AuthLoginEvent> {
    return {
      opening_browser: () => {},
      browser_open_failed: () => {},
      device_verification: (e) => {
        console.log(JSON.stringify({
          status: "device_verification",
          userCode: e.userCode,
          verificationUri: e.verificationUri,
          verificationUriComplete: e.verificationUriComplete,
        }));
      },
      polling: () => {},
      securing_session: () => {},
      completed: (e) => {
        console.log(JSON.stringify(
          {
            authenticated: true,
            serverUrl: e.data.serverUrl,
            username: e.data.username,
          },
          null,
          2,
        ));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

/** Create the appropriate auth login renderer for the given output mode. */
export function createAuthLoginRenderer(
  mode: OutputMode,
  showSpinner: boolean,
): Renderer<AuthLoginEvent> {
  switch (mode) {
    case "json":
      return new JsonAuthLoginRenderer();
    case "log":
      return new LogAuthLoginRenderer(showSpinner);
  }
}
