import { AxiError, exitCodeForError } from "axi-sdk-js";
import type { Dep, DepType } from "./model.js";
import {
  type SuggestionGlobals,
  withSuggestionGlobals,
} from "./suggestions.js";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "LOCKED"
  | "CONFLICT"
  | "UNSUPPORTED"
  | "UNKNOWN";

export { AxiError, exitCodeForError };

interface NotFoundOptions {
  globals?: SuggestionGlobals;
  suggestions?: string[];
}

/** A task id was referenced that does not exist in the backlog. */
export function notFound(id: string, options: NotFoundOptions = {}): AxiError {
  const suggestions =
    options.suggestions ??
    withSuggestionGlobals(
      ["Run `tasks-axi list` to see existing tasks"],
      options.globals,
    );
  return new AxiError(
    `Task "${id}" not found in this backlog`,
    "NOT_FOUND",
    suggestions,
  );
}

/**
 * Moving `id` out of a collection would leave active dependents behind, still
 * blocked by a task that is no longer there. Raised by the markdown backend
 * (walking its locked document) and by the command-layer fallback (walking core
 * Store verbs) alike, so the detection may differ but the wording cannot.
 */
export function stillBlockingError(id: string, stranded: string[]): AxiError {
  return new AxiError(
    `Task "${id}" is still blocking active tasks: ${stranded.join(", ")}`,
    "VALIDATION_ERROR",
    [
      `Move them together, or unblock them first, e.g. \`tasks-axi unblock ${stranded[0]} --by ${id}\``,
    ],
  );
}

/**
 * Moving `id` out of a collection would leave rows behind that reference it
 * through a NON-blocking edge (`parent`, `discovered-from`). Separate wording
 * from `stillBlockingError` because nothing here is blocked: what is at stake
 * is the edge itself. On a graph backend `bd delete --force` strips the
 * deleted row's edges off its surviving dependents, so the edge and its reason
 * would be lost with no retry able to restore them.
 */
export function strandedDependentError(
  id: string,
  dependents: { id: string; type: DepType }[],
): AxiError {
  const named = dependents
    .map((dependent) => `${dependent.id} (${dependent.type})`)
    .join(", ");
  return new AxiError(
    `Task "${id}" is still referenced by ${named}: moving it would strip that edge`,
    "VALIDATION_ERROR",
    [
      `Move them together, or remove the edge first, e.g. \`bd dep remove ${dependents[0].id} ${id}\``,
    ],
  );
}

/** Moving `id` would leave one of its own edges pointing across collections. */
export function strandedDepError(id: string, dep: Dep): AxiError {
  const label = dep.type === "blocked-by" ? "blocker" : "dependency";
  return new AxiError(
    `Cannot move "${id}": its ${label} "${dep.id}" would be stranded (not in the moved set and absent from the destination)`,
    "VALIDATION_ERROR",
    [`Add "${dep.id}" to the same \`mv\`, or move it to the destination first`],
  );
}

/**
 * The one operator-facing contract for a move that copied a task into the
 * destination, then failed to remove the source AND failed to roll the copy
 * back. Both the atomic backend path and the command-layer fallback raise it,
 * so the wording an operator has to act on cannot drift between them.
 */
export function partialMoveError(
  id: string,
  originalError: unknown,
  rollbackError: unknown,
  destination?: string,
): AxiError {
  return new AxiError(
    `Move of "${id}" partially completed; task now exists in both backlogs`,
    "CONFLICT",
    [
      destination
        ? `Remove "${id}" from ${destination} manually before retrying`
        : "Remove the duplicate from the destination backlog manually before retrying",
      `Source removal failed: ${describeError(originalError)}`,
      `Destination rollback failed: ${describeError(rollbackError)}`,
    ],
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Where each id of an interrupted multi-task transfer ended up. */
export interface SplitTransferState {
  /** The id whose source removal failed, stopping the transfer. */
  failed: string;
  /** What the backend reported for the failed removal. */
  detail: string;
  source: string;
  destination: string;
  /** Removed from the source already: now only in the destination. */
  movedOnly: string[];
  /** Destination copy rolled back: still only in the source. */
  returned: string[];
  /** Destination copy could not be rolled back: in BOTH collections. */
  stuck: string[];
  /**
   * Destination copy deliberately KEPT, because removing it would have stripped
   * a dependency edge off a dependent the destination still holds: in BOTH
   * collections, but by choice rather than by failure.
   */
  held: string[];
}

/**
 * A multi-task move that could not be completed as one unit. Two record stores
 * cannot share a transaction, so the operator-facing contract is not
 * all-or-nothing but *recoverable*: the transfer stops at the first failed
 * source removal, every untouched source row is left alone, and this error
 * names exactly which ids now live where so the move can be finished or
 * reverted by hand. Lives here, beside `partialMoveError`, so the wording an
 * operator acts on cannot drift between the backends that raise it.
 */
export function splitTransferError(state: SplitTransferState): AxiError {
  const split =
    state.movedOnly.length > 0 ||
    state.stuck.length > 0 ||
    state.held.length > 0;
  const suggestions: string[] = [];
  if (state.movedOnly.length > 0) {
    suggestions.push(
      `Now only in ${state.destination}: ${state.movedOnly.join(", ")}`,
    );
  }
  if (state.returned.length > 0) {
    suggestions.push(
      `Still only in ${state.source}: ${state.returned.join(", ")}`,
    );
  }
  if (state.stuck.length > 0) {
    suggestions.push(
      `In BOTH collections — remove from ${state.destination} by hand: ${state.stuck.join(", ")}`,
    );
  }
  if (state.held.length > 0) {
    suggestions.push(
      `In BOTH collections — kept in ${state.destination} on purpose, because deleting them there would have stripped the dependency edges off dependents that already moved: ${state.held.join(", ")}`,
    );
  }
  if (split) {
    suggestions.push(
      `Finish the move by re-running it for the ids still in ${state.source}, or revert it by moving the others back`,
    );
  }
  suggestions.push(`Source removal failed: ${state.detail}`);
  return new AxiError(
    split
      ? `Move of "${state.failed}" could not remove it from ${state.source}; the set is now split across two collections`
      : `Move of "${state.failed}" was refused by ${state.source}; no task left it and every destination copy was rolled back`,
    "CONFLICT",
    suggestions,
  );
}

/**
 * The source is intact but rolling the destination back left copies behind, so
 * the operator is told about the original fault AND the residue.
 */
export function rollbackResidueError(
  cause: unknown,
  stuck: string[],
  source: string,
  destination: string,
): AxiError {
  return new AxiError(
    `Transfer failed, and rolling the destination back left ${stuck.join(", ")} in ${destination}`,
    "CONFLICT",
    [
      `Every task is still in ${source}; remove ${stuck.join(", ")} from ${destination} by hand, then retry`,
      `Transfer failed: ${describeError(cause)}`,
    ],
  );
}

/**
 * A capability the active backend does not support was requested. The
 * capability is named so the error is actionable rather than a raw failure
 * (AXI house style §6; report §8 graceful degradation).
 */
export function unsupported(capability: string, backend: string): AxiError {
  return new AxiError(
    `The ${backend} backend does not support ${capability}`,
    "UNSUPPORTED",
  );
}
