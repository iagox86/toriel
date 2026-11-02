// /command (and, in a session, @file / path) completion for the chat box. The
// provider asks `source` what applies at every keystroke, so the switcher/
// session context switch and newly registered commands need no re-wiring.
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  CombinedAutocompleteProvider,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { type CompletionSources, usageHint } from "./cli.ts";
import { type CommandSpec, SESSION_COMMANDS, SWITCHER_COMMANDS } from "./commands.ts";

export interface AutocompleteContext {
  /** Switcher box: only toriel's commands, no file completion. */
  switcher: boolean;
  /** A group heading is highlighted in the switcher, so commands that need a session would only fail. */
  headerSelected?: boolean;
  /** Commands pi reported for the viewed session. */
  piCommands: ReadonlyArray<{ name: string; description?: string }>;
  cwd: string;
  /** Live data for argument completion; without it commands complete by name only. */
  sources?: CompletionSources;
}

/** The slash commands that apply in `ctx`; toriel's own win a name clash with pi's. */
export function commandsFor(ctx: AutocompleteContext): SlashCommand[] {
  const own: readonly CommandSpec[] = ctx.switcher ? SWITCHER_COMMANDS : SESSION_COMMANDS;
  const taken = new Set(own.map((c) => c.name));
  return [
    ...own.filter((c) => !(ctx.headerSelected && c.needsSession)).map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: usageHint(c) || undefined,
      getArgumentCompletions: async (typed: string) => {
        const choices = c.complete && ctx.sources ? await c.complete(typed, ctx.sources) : [];
        return choices.map((c) => (typeof c === "string" ? { value: c, label: c } : { value: c.value, label: c.value, description: c.description }));
      },
    })),
    ...(ctx.switcher ? [] : ctx.piCommands.filter((c) => !taken.has(c.name))),
  ];
}

const isEmpty = (lines: string[]): boolean => lines.every((l) => l.trim() === "");

export class CommandAutocomplete implements AutocompleteProvider {
  private readonly source: () => AutocompleteContext;

  constructor(source: () => AutocompleteContext) {
    this.source = source;
  }

  private delegate(): { ctx: AutocompleteContext; provider: CombinedAutocompleteProvider } {
    const ctx = this.source();
    return { ctx, provider: new CombinedAutocompleteProvider(commandsFor(ctx), ctx.cwd, null) };
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const { ctx, provider } = this.delegate();
    if (isEmpty(lines)) {
      // tab on an empty box would list files; the command list is the useful default
      return provider.getSuggestions(["/"], 0, 1, { ...options, force: false });
    }
    if (ctx.switcher && !(cursorLine === 0 && (lines[0] ?? "").startsWith("/"))) {
      return null;
    }
    return provider.getSuggestions(lines, cursorLine, cursorCol, options);
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
    if (isEmpty(lines) && prefix === "/") {
      // the suggestions were computed for "/", which the box does not hold yet
      return this.delegate().provider.applyCompletion(["/"], 0, 1, item, prefix);
    }
    return this.delegate().provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const { ctx, provider } = this.delegate();
    return (ctx.switcher ? isEmpty(lines) : true) && provider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}
