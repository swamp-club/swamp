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
  if (key.length <= 16) return key.slice(0, 8) + dim("\u2022\u2022\u2022");
  return key.slice(0, 12) + dim("\u2022\u2022\u2022") + key.slice(-4);
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
  lines.push(green(`  \u2554${"\u2550".repeat(contentWidth)}\u2557`));

  // Header
  const headerPad = " ".repeat(contentWidth - headerTextWidth - 2);
  lines.push(
    green("  \u2551") + `  ${header}${headerPad}` + green("\u2551"),
  );

  // Divider
  lines.push(green(`  \u2560${"\u2550".repeat(contentWidth)}\u2563`));

  // Body groups
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];

    // Spacer before each group
    lines.push(green("  \u2551") + " ".repeat(contentWidth) + green("\u2551"));

    for (const row of group) {
      const paddedLabel = row.label.padEnd(labelWidth);
      const visibleValueLen = stripAnsi(row.value).length;
      const valuePad = " ".repeat(rawValueWidth - visibleValueLen);
      const extraPad = " ".repeat(contentWidth - rowInnerWidth);
      lines.push(
        green("  \u2551") + "  " + bold(cyan(paddedLabel)) + "   " +
          row.value +
          valuePad + extraPad + "  " + green("\u2551"),
      );
    }

    // Spacer after last group
    if (gi === groups.length - 1) {
      lines.push(
        green("  \u2551") + " ".repeat(contentWidth) + green("\u2551"),
      );
    }
  }

  // Bottom border
  lines.push(green(`  \u255a${"\u2550".repeat(contentWidth)}\u255d`));

  return lines;
}

function renderDeviceVerification(deviceCode: string): void {
  const lines = renderCard(
    bold("Verify your device"),
    [[{ label: "Code", value: bold(yellow(deviceCode)) }]],
  );
  lines.push("");
  lines.push(
    "  Confirm this code matches in your browser before signing in.",
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
    `${green("\u2714")} ${bold("Authenticated")}`,
    [identity, session],
  );

  writeOutput(lines.join("\n"));
}

// ─── Renderers ────────────────────────────────────────────────────────

class LogAuthLoginRenderer implements Renderer<AuthLoginEvent> {
  private spinner: Spinner | null = null;

  constructor(private showSpinner: boolean) {}

  handlers(): EventHandlers<AuthLoginEvent> {
    return {
      opening_browser: () => {
        if (this.showSpinner) {
          this.spinner = new Spinner();
          this.spinner.start("Opening browser...");
        }
      },
      browser_open_failed: (e) => {
        this.spinner?.stop();
        console.log(e.message);
        if (this.showSpinner) {
          this.spinner = new Spinner();
          this.spinner.start("Waiting for authentication...");
        }
      },
      device_verification: (e) => {
        this.spinner?.stop();
        renderDeviceVerification(e.deviceCode);
        console.log();
        if (this.showSpinner) {
          this.spinner = new Spinner();
          this.spinner.start("Waiting for authentication...");
        }
      },
      waiting_for_auth: () => {
        // Spinner already started in device_verification handler
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
      device_verification: () => {},
      waiting_for_auth: () => {},
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
