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

import type { FolderPicker } from "../../domain/start/folder_picker.ts";
import { defaultCommandResolver } from "./resolve_command.ts";

/** What running a chooser produced. */
export interface PickerRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Dependencies of {@link SystemFolderPicker}, injected for testing. */
export interface FolderPickerDeps {
  readonly os: typeof Deno.build.os;
  readonly env: (name: string) => string | undefined;
  /** Resolves an executable on PATH to its absolute path. */
  readonly resolve: (name: string) => Promise<string | null>;
  /** Runs a command to completion, capturing its output. */
  readonly run: (
    command: string,
    args: readonly string[],
  ) => Promise<PickerRun>;
}

/** One chooser invocation: the command and its arguments. */
export interface PickerCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Quotes text for an AppleScript or PowerShell string literal. The prompt is
 * always Swamp's own fixed text; this only keeps it well-formed.
 */
function scriptString(value: string, quote: '"' | "'"): string {
  return quote === '"'
    ? `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`
    : `'${value.replace(/'/g, "''")}'`;
}

/**
 * Opens the OS folder chooser: `osascript` on macOS, a Windows Forms dialog
 * through PowerShell on Windows, `zenity` or `kdialog` on Linux. Over SSH,
 * without a display, or with none of those installed, it is unavailable.
 */
export class SystemFolderPicker implements FolderPicker {
  constructor(private readonly deps: FolderPickerDeps) {}

  async available(): Promise<boolean> {
    return (await this.command("")) !== null;
  }

  async pick(prompt: string): Promise<string | null> {
    const chosen = await this.command(prompt);
    if (chosen === null) {
      throw new Error("No folder chooser is available on this machine.");
    }
    const result = await this.deps.run(chosen.command, chosen.args);
    const path = result.stdout.replace(/[\r\n]+$/, "");
    if (result.code !== 0) {
      // Every chooser exits non-zero when the user cancels: osascript with
      // error -128, zenity and kdialog with 1, and the PowerShell script
      // writes nothing.
      if (cancelled(this.deps.os, result)) return null;
      throw new Error(
        `The folder chooser failed: ${result.stderr.trim() || result.code}`,
      );
    }
    return path === "" ? null : trimTrailingSeparator(path);
  }

  /** The chooser command for this machine, or null when there is none. */
  async command(prompt: string): Promise<PickerCommand | null> {
    const { os, env } = this.deps;
    if (env("SSH_CONNECTION")) return null;
    if (os === "darwin") {
      const osascript = await this.deps.resolve("osascript");
      if (!osascript) return null;
      return {
        command: osascript,
        args: [
          // Bring the dialog in front of the browser.
          "-e",
          "tell me to activate",
          "-e",
          `POSIX path of (choose folder with prompt ${
            scriptString(prompt, '"')
          })`,
        ],
      };
    }
    if (os === "windows") {
      const powershell = await this.deps.resolve("powershell");
      if (!powershell) return null;
      const script = [
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "Add-Type -AssemblyName System.Windows.Forms",
        // A topmost owner keeps the dialog in front of the browser.
        "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        `$dialog.Description = ${scriptString(prompt, "'")}`,
        "$dialog.ShowNewFolderButton = $false",
        "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
      ].join("; ");
      return {
        command: powershell,
        args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
      };
    }
    if (!env("DISPLAY") && !env("WAYLAND_DISPLAY")) return null;
    const zenity = await this.deps.resolve("zenity");
    if (zenity) {
      return {
        command: zenity,
        args: ["--file-selection", "--directory", `--title=${prompt}`],
      };
    }
    const kdialog = await this.deps.resolve("kdialog");
    if (kdialog) {
      return {
        command: kdialog,
        args: [
          "--getexistingdirectory",
          env("HOME") ?? ".",
          "--title",
          prompt,
        ],
      };
    }
    return null;
  }
}

function cancelled(os: string, result: PickerRun): boolean {
  if (os === "darwin") return /-128/.test(result.stderr);
  // zenity and kdialog exit 1 on cancel with nothing written.
  return result.code === 1 && result.stdout.trim() === "";
}

/** Drops a trailing separator, keeping a root such as `/` or `C:\`. */
function trimTrailingSeparator(path: string): string {
  if (path === "/" || /^[A-Za-z]:[\\/]$/.test(path)) return path;
  return path.replace(/[\\/]+$/, "");
}

/** The real chooser for this machine. */
export function createSystemFolderPicker(): SystemFolderPicker {
  const resolver = defaultCommandResolver();
  return new SystemFolderPicker({
    os: Deno.build.os,
    env: (name) => Deno.env.get(name),
    resolve: (name) => resolver.resolve(name),
    run: async (command, args) => {
      const output = await new Deno.Command(command, {
        args: [...args],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const decoder = new TextDecoder();
      return {
        code: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
      };
    },
  });
}
