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
