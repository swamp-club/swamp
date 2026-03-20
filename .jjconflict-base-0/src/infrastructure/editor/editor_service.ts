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

/**
 * Result of opening a file in an editor.
 */
export interface EditorResult {
  editor: string;
  path: string;
}

/**
 * Options for opening a file in an editor.
 */
export interface OpenFileOptions {
  /**
   * Whether to wait for the editor to close before returning.
   * If not specified, automatically detects based on editor type:
   * - Terminal editors (vim, nvim, nano, etc.): wait
   * - GUI editors (code, zed, subl, etc.): don't wait
   */
  wait?: boolean;
}

/**
 * The list of fallback editors to try when $EDITOR is not set.
 */
const FALLBACK_EDITORS = ["code", "zed", "nvim", "vim", "nano", "emacs"];

/**
 * Terminal editors that run inside the terminal and require waiting.
 */
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
]);

/**
 * Service for finding and launching the user's preferred editor.
 */
export class EditorService {
  /**
   * Finds the user's preferred editor.
   *
   * Checks $EDITOR environment variable first, then falls back to common editors.
   *
   * @returns The name of the editor command
   * @throws Error if no editor could be found
   */
  async findEditor(): Promise<string> {
    // First check $EDITOR environment variable
    const editorEnv = Deno.env.get("EDITOR");
    if (editorEnv) {
      // Extract just the command name (in case it has arguments)
      const editorCmd = editorEnv.split(" ")[0];
      if (await this.isCommandAvailable(editorCmd)) {
        return editorEnv;
      }
    }

    // Try fallback editors
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

  /**
   * Opens a file in the user's preferred editor.
   *
   * @param filePath - The path to the file to edit
   * @param options - Options for opening the file
   * @returns Information about the editor that was launched
   */
  async openFile(
    filePath: string,
    options: OpenFileOptions = {},
  ): Promise<EditorResult> {
    const editor = await this.findEditor();

    // Determine whether to wait: use explicit option, or auto-detect based on editor type
    const shouldWait = options.wait ?? this.isTerminalEditor(editor);

    const args = this.buildEditorArgs(editor, filePath, { wait: shouldWait });

    const command = new Deno.Command(args[0], {
      args: args.slice(1),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    if (shouldWait) {
      // Wait for the editor to close (terminal editors)
      const process = command.spawn();
      await process.status;
    } else {
      // Spawn and return immediately (GUI editors)
      command.spawn();
    }

    return {
      editor: this.getEditorDisplayName(editor),
      path: filePath,
    };
  }

  /**
   * Checks if an editor is a terminal-based editor that requires waiting.
   */
  private isTerminalEditor(editor: string): boolean {
    const baseEditor = editor.split(" ")[0];
    return TERMINAL_EDITORS.has(baseEditor);
  }

  /**
   * Checks if a command is available in the system PATH.
   */
  private async isCommandAvailable(cmd: string): Promise<boolean> {
    try {
      const command = new Deno.Command("which", {
        args: [cmd],
        stdout: "null",
        stderr: "null",
      });
      const { success } = await command.output();
      return success;
    } catch {
      return false;
    }
  }

  /**
   * Builds the arguments array for launching the editor.
   */
  private buildEditorArgs(
    editor: string,
    filePath: string,
    options: OpenFileOptions,
  ): string[] {
    const args: string[] = [];

    // Handle editors that may have arguments in $EDITOR
    const editorParts = editor.split(" ");
    args.push(...editorParts);

    // Add wait flag for supported editors
    if (options.wait) {
      const baseEditor = editorParts[0];
      if (baseEditor === "code" || baseEditor === "code-insiders") {
        args.push("--wait");
      } else if (baseEditor === "zed") {
        args.push("--wait");
      } else if (baseEditor === "subl" || baseEditor === "sublime") {
        args.push("--wait");
      }
    }

    args.push(filePath);
    return args;
  }

  /**
   * Gets a human-readable display name for an editor.
   */
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
