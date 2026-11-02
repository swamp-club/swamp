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

import { basename } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import { defaultCommandResolver } from "../process/resolve_command.ts";

export interface EditorResult {
  editor: string;
  path: string;
  /** a non-zero exit (vim's :cq) means the person abandoned the edit */
  success?: boolean;
}

export interface EditorLaunch {
  editor: string;
  waitsForExit: boolean;
  args?: readonly string[];
  /**
   * an unknown editor is waited for, but may hand the file to another process
   * and exit before the person has saved
   */
  waitConfirmed?: boolean;
  open: () => Promise<EditorResult>;
}

export interface OpenFileOptions {
  wait?: boolean;
  /**
   * wait for every editor, and refuse a launcher that hands the file to another
   * program and exits at once; set by a caller that reads the file back after
   * the editor closes
   */
  requireWait?: boolean;
}

const FALLBACK_EDITORS = ["code", "zed", "nvim", "vim", "nano", "emacs"];

const TERMINAL_EDITORS = new Set([
  "vim",
  "vi",
  "nvim",
  "nano",
  "emacs",
  "pico",
  "joe",
  "ne",
  "micro",
  "helix",
  "hx",
  "kak",
  "vis",
  "mg",
]);

/**
 * GUI editors that return at once unless passed a flag; every other editor is
 * waited for until its process exits
 */
const WAIT_FLAGS: Record<string, { flag: string; aliases: string[] }> = {
  code: { flag: "--wait", aliases: ["-w"] },
  "code-insiders": { flag: "--wait", aliases: ["-w"] },
  cursor: { flag: "--wait", aliases: ["-w"] },
  windsurf: { flag: "--wait", aliases: ["-w"] },
  zed: { flag: "--wait", aliases: ["-w"] },
  subl: { flag: "--wait", aliases: ["-w"] },
  sublime: { flag: "--wait", aliases: ["-w"] },
  atom: { flag: "--wait", aliases: ["-w"] },
  mate: { flag: "-w", aliases: ["--wait"] },
  gvim: { flag: "-f", aliases: ["--nofork"] },
  mvim: { flag: "-f", aliases: ["--nofork"] },
};

/**
 * Launchers that hand the file to another program and exit at once, so
 * waiting for them waits for nothing. macOS `open` waits only with `-W`.
 */
const NON_WAITING_LAUNCHERS = new Set(["xdg-open", "gio", "start", "explorer"]);

function commandName(command: string): string {
  return basename(command).replace(/\.(exe|cmd|bat)$/i, "");
}

function isNonWaitingLauncher(editorParts: string[]): boolean {
  const base = commandName(editorParts[0]);
  if (base === "open") {
    // -W, alone or among combined short flags (-Wa), makes open wait.
    return !editorParts.some((part) =>
      part === "--wait-apps" || /^-[A-Za-z]*W[A-Za-z]*$/.test(part)
    );
  }
  return NON_WAITING_LAUNCHERS.has(base);
}

export class EditorService {
  async findEditor(): Promise<string> {
    const editorEnv = Deno.env.get("EDITOR");
    if (editorEnv) {
      const editorCmd = editorEnv.split(" ")[0];
      if (await this.isCommandAvailable(editorCmd)) {
        return editorEnv;
      }
    }

    for (const editor of FALLBACK_EDITORS) {
      if (await this.isCommandAvailable(editor)) {
        return editor;
      }
    }

    throw new Error(
      "No editor found. Set $EDITOR environment variable or install one of: " +
        FALLBACK_EDITORS.join(", "),
    );
  }

  async openFile(
    filePath: string,
    options: OpenFileOptions = {},
  ): Promise<EditorResult> {
    const launch = await this.prepareOpenFile(filePath, options);
    return await launch.open();
  }

  async prepareOpenFile(
    filePath: string,
    options: OpenFileOptions = {},
  ): Promise<EditorLaunch> {
    const editor = await this.findEditor();

    if (options.requireWait && isNonWaitingLauncher(editor.split(" "))) {
      throw new UserError(
        `The editor '${editor}' opens the file in another program and ` +
          `returns at once, so swamp cannot tell when the edit is saved. ` +
          `Set EDITOR to an editor that waits for the file to close ` +
          `(for example 'code --wait' or 'vim'), or pipe the YAML on stdin.`,
        "editor_cannot_wait",
      );
    }

    const shouldWait = options.requireWait ||
      (options.wait ?? this.isTerminalEditor(editor));

    const args = this.buildEditorArgs(editor, filePath, { wait: shouldWait });
    const editorParts = editor.split(" ");
    const waitFlag = WAIT_FLAGS[commandName(editorParts[0])];
    const waitConfirmed = shouldWait &&
      (this.isTerminalEditor(editor) ||
        (waitFlag !== undefined &&
          [waitFlag.flag, ...waitFlag.aliases].some((flag) =>
            args.includes(flag)
          )) ||
        (commandName(editorParts[0]) === "open" && !isNonWaitingLauncher(
          editorParts,
        )) ||
        // emacsclient waits for the buffer to be finished unless told not to.
        (commandName(editorParts[0]) === "emacsclient" &&
          !editorParts.some((part) => part === "-n" || part === "--no-wait")));
    return {
      editor: this.getEditorDisplayName(editor),
      waitsForExit: shouldWait,
      args,
      waitConfirmed,
      open: async () => {
        const command = new Deno.Command(args[0], {
          args: args.slice(1),
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });

        if (shouldWait) {
          const process = command.spawn();
          const status = await process.status;
          return {
            editor: this.getEditorDisplayName(editor),
            path: filePath,
            success: status.success,
          };
        }
        command.spawn();
        return {
          editor: this.getEditorDisplayName(editor),
          path: filePath,
        };
      },
    };
  }

  private isTerminalEditor(editor: string): boolean {
    return TERMINAL_EDITORS.has(commandName(editor.split(" ")[0]));
  }

  private async isCommandAvailable(cmd: string): Promise<boolean> {
    const path = await defaultCommandResolver().resolve(cmd);
    return path !== null;
  }

  private buildEditorArgs(
    editor: string,
    filePath: string,
    options: OpenFileOptions,
  ): string[] {
    const args: string[] = [];

    const editorParts = editor.split(" ");
    args.push(...editorParts);

    // Add the wait flag for GUI editors that have one, unless $EDITOR
    // already carries it
    const waitFlag = WAIT_FLAGS[commandName(editorParts[0])];
    if (
      options.wait && waitFlag &&
      ![waitFlag.flag, ...waitFlag.aliases].some((flag) =>
        editorParts.includes(flag)
      )
    ) {
      args.push(waitFlag.flag);
    }

    args.push(filePath);
    return args;
  }

  private getEditorDisplayName(editor: string): string {
    const baseEditor = editor.split(" ")[0];
    const displayNames: Record<string, string> = {
      code: "VS Code",
      "code-insiders": "VS Code Insiders",
      zed: "Zed",
      nvim: "Neovim",
      vim: "Vim",
      nano: "nano",
      emacs: "Emacs",
      subl: "Sublime Text",
      sublime: "Sublime Text",
    };
    return displayNames[baseEditor] ?? baseEditor;
  }
}
