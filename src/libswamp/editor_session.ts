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

import { join } from "@std/path";
import { markErrorPaths, UserError } from "../domain/errors.ts";
import {
  type EditorLaunch,
  EditorService,
} from "../infrastructure/editor/editor_service.ts";

/** Dependencies for an editor session. */
export interface EditorSessionDeps {
  /** Resolves the editor for `path`; the real one waits for every editor. */
  prepareEditor: (path: string) => Promise<EditorLaunch>;
}

let depsForTesting: EditorSessionDeps | undefined;

/**
 * Test seam: makes {@link createEditorSessionDeps} return `deps` until the
 * returned function is called, so a test can stand in for the person at the
 * editor without starting a process. Only tests may call it.
 */
export function useEditorSessionDepsForTesting(
  deps: EditorSessionDeps,
): () => void {
  if (depsForTesting !== undefined) {
    throw new Error("editor session deps for testing are already installed");
  }
  depsForTesting = deps;
  return () => {
    depsForTesting = undefined;
  };
}

/** Wires the user's editor into EditorSessionDeps. */
export function createEditorSessionDeps(): EditorSessionDeps {
  if (depsForTesting !== undefined) return depsForTesting;
  const editorService = new EditorService();
  return {
    prepareEditor: (path) =>
      editorService.prepareOpenFile(path, { requireWait: true }),
  };
}

/** What is announced before the editor starts. */
export interface EditorLaunchingData {
  editor: string;
  path: string;
  waitsForExit: boolean;
}

/** Input for an editor session. */
export interface EditorSessionInput {
  /** The stored text the editor opens. */
  content: string;
  /** The temp file's name, so the editor can tell the file is YAML. */
  fileName: string;
  onLaunching?: (data: EditorLaunchingData) => void;
}

/** How an editor session ended. */
export type EditorSessionResult =
  | {
    status: "unchanged";
    editor: string;
    /**
     * Set only when the launch reports `waitConfirmed: false`: the editor is
     * not known to stay open until the file is closed and may have returned
     * before the person saved, so the copy is kept here rather than
     * removed. A launch that does not report it is trusted to have waited.
     */
    keptPath?: string;
  }
  | {
    status: "edited";
    editor: string;
    content: string;
    /** The temp file holding the edit, kept until `discard` is called. */
    tempPath: string;
    discard: () => Promise<void>;
  };

/**
 * Opens the user's editor on a private temp copy of `content` and reads the
 * edit back once the editor closes. The stored file is never opened, so the
 * caller saves the edit through its repository like any other edit
 * (swamp-club#4107). An unchanged copy is removed; an edited one is kept
 * until the caller discards it, so a refused save can be retried from it.
 */
export async function editInEditor(
  deps: EditorSessionDeps,
  input: EditorSessionInput,
): Promise<EditorSessionResult> {
  // Created 0700, so the copy is readable by the user only.
  const dir = await Deno.makeTempDir({ prefix: "swamp-edit-" });
  const tempPath = join(dir, tempFileName(input.fileName));
  const discard = async () => {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  };
  // Set once the copy holds an edit that must survive a thrown error.
  let keep = false;
  try {
    await Deno.writeTextFile(tempPath, input.content, { mode: 0o600 });
    const launch = await deps.prepareEditor(tempPath);
    input.onLaunching?.({
      editor: launch.editor,
      path: tempPath,
      waitsForExit: launch.waitsForExit,
    });
    const { editor, success } = await launch.open();
    const content = await Deno.readTextFile(tempPath);
    const changed = content !== input.content;
    if (success === false) {
      // A non-zero exit (vim's :cq) abandons the edit, as git treats it.
      keep = changed;
      throw markErrorPaths(
        new UserError(
          `${editor} exited with an error, so nothing was saved.` +
            (changed ? ` Your edit is kept at ${tempPath}.` : ""),
          "editor_failed",
        ),
        [tempPath],
      );
    }
    if (!changed) {
      if (launch.waitConfirmed === false) {
        return { status: "unchanged", editor, keptPath: tempPath };
      }
      await discard();
      return { status: "unchanged", editor };
    }
    return { status: "edited", editor, content, tempPath, discard };
  } catch (error) {
    if (!keep) await discard();
    throw error;
  }
}

function tempFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-");
  return safe.endsWith(".yaml") ? safe : `${safe}.yaml`;
}
