import { CompletionsCommand } from "@cliffy/command/completions";

/**
 * Shell completion command using Cliffy's built-in CompletionsCommand.
 *
 * Usage:
 *   swamp completion bash    # Generate bash completion script
 *   swamp completion zsh     # Generate zsh completion script
 *   swamp completion fish    # Generate fish completion script
 *
 * Installation:
 *   # Bash - add to ~/.bashrc:
 *   source <(swamp completion bash)
 *
 *   # Zsh - add to ~/.zshrc:
 *   source <(swamp completion zsh)
 *
 *   # Fish - save to completions directory:
 *   swamp completion fish > ~/.config/fish/completions/swamp.fish
 */
export const completionCommand = new CompletionsCommand();
