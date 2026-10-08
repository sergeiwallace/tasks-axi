import { BeadsStore } from "./backends/beads.js";
import { MarkdownStore } from "./backends/markdown.js";
import {
  type ConfigOverrides,
  type ResolvedConfig,
  resolveConfig,
} from "./config.js";
import { AxiError } from "./errors.js";
import type { Store } from "./store.js";
import type { SuggestionGlobals } from "./suggestions.js";

/**
 * The resolved CLI context: the active backend Store plus the config that
 * selected it. The command layer only ever talks to `Store`, so swapping in
 * sqlite/remote backends (P2/P3) never touches arg parsing or rendering.
 */
export interface TasksContext {
  store: Store;
  config: ResolvedConfig;
  suggestionGlobals?: SuggestionGlobals;
}

export function resolveTasksContext(
  overrides: ConfigOverrides = {},
  suggestionGlobals?: SuggestionGlobals,
): TasksContext {
  const config = resolveConfig(overrides);
  const store = createStore(config);
  return {
    store,
    config,
    ...(suggestionGlobals ? { suggestionGlobals } : {}),
  };
}

/**
 * Build the Store a resolved config selects. Command code calls this instead of
 * constructing a backend directly, so a command that needs a second store (mv's
 * destination backlog) stays as backend-agnostic as the rest of the CLI layer.
 */
export function createStore(config: ResolvedConfig): Store {
  if (config.backend === "markdown") {
    return new MarkdownStore({
      path: config.path,
      ...(config.archivePath ? { archivePath: config.archivePath } : {}),
    });
  }
  if (config.backend === "beads") {
    // A beads home is addressed by its `.beads` directory alone. No markdown
    // path reaches the adapter: the graph is the sole record, so there is
    // nothing to mirror and no archive file to write.
    return new BeadsStore({
      path: config.beads.path,
      binary: config.beads.binary,
      ...(config.beads.prefix ? { prefix: config.beads.prefix } : {}),
    });
  }
  throw new AxiError(
    `Unsupported backend "${config.backend}" — available backends: markdown, beads`,
    "UNSUPPORTED",
    [
      'Set `backend = "markdown"` or `backend = "beads"` in .tasks.toml, or omit --backend',
    ],
  );
}

/** Narrow an optional context to a present one (the resolver always sets it). */
export function requireCtx(ctx: TasksContext | undefined): TasksContext {
  if (!ctx) {
    throw new AxiError("backlog context was not resolved", "UNKNOWN");
  }
  return ctx;
}
