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
 * The machine's own folder chooser, for importing a workspace. A web page
 * can't learn a folder's path, but the `swamp start` server runs on the
 * same machine and can ask the OS to show its dialog.
 */
export interface FolderPicker {
  /** False over SSH, without a display, or when no chooser is installed. */
  available(): Promise<boolean>;
  /** The chosen folder's absolute path, or null when the user cancelled. */
  pick(prompt: string): Promise<string | null>;
}
