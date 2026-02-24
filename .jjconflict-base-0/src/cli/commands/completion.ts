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

import { CompletionsCommand } from "@cliffy/command/completions";

/**
 * Shell completion command using Cliffy's built-in CompletionsCommand.
 *
 * Usage:
 *   swamp completions bash    # Generate bash completion script
 *   swamp completions zsh     # Generate zsh completion script
 *   swamp completions fish    # Generate fish completion script
 *
 * Installation:
 *
 *   # Bash - add to ~/.bashrc:
 *   eval "$(swamp completions bash)"
 *
 *   # Zsh with oh-my-zsh - save to completions directory:
 *   mkdir -p ~/.oh-my-zsh/completions
 *   swamp completions zsh > ~/.oh-my-zsh/completions/_swamp
 *   rm -f ~/.zcompdump* && exec zsh
 *
 *   # Zsh without oh-my-zsh - add to ~/.zshrc:
 *   eval "$(swamp completions zsh)"
 *
 *   # Fish - save to completions directory:
 *   swamp completions fish > ~/.config/fish/completions/swamp.fish
 *
 * Note: Model and workflow name completions are directory-dependent.
 * They return names from the current working directory's swamp repository.
 */
export const completionCommand = new CompletionsCommand();
