import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  AxiError,
  rollbackResidueError,
  splitTransferError,
  stillBlockingError,
  strandedDepError,
} from "../errors.js";
import { validateDependencyId, validateId } from "../id.js";
import type {
  Dep,
  DepType,
  Hold,
  State,
  Task,
  TaskInput,
  TaskLink,
  TaskPatch,
  TaskQuery,
  TaskUpdateChange,
  TaskUpdateResult,
  TransitionOpts,
} from "../model.js";
import {
  PUBLIC_FOLLOWUP_KIND,
  assertPublicFollowupMutation,
  assertPublicFollowupTaskState,
  canonicalEqual,
  decodePublicFollowup,
  encodePublicFollowup,
  isPublicFollowupTask,
  isPublicFollowupTerminal,
  normalizePublicFollowup,
  type PublicFollowupMutation,
} from "../public-followup.js";
import type { Capabilities, Store } from "../store.js";
import { withLock, withLocks } from "./lock.js";
import { deriveLinks } from "./markdown-grammar.js";
// Field normalization is shared with every other backend (PR #52's extraction),
// so a task accepted by the markdown backend is accepted here byte-for-byte.
import {
  appendTitleLink,
  bodyHasLine,
  normalizeDate,
  normalizeDep,
  normalizeHold,
  normalizePriority,
  normalizeTagValue,
  normalizeTitle,
  sameHold,
  sameMeta,
  taskToInput,
} from "./normalize.js";

/**
 * Beads-backed store (AIH-nta1e).
 *
 * Beads' Dolt-backed `.beads/` store stays authoritative: every read and write
 * goes through the configured `bd` CLI with `--json`, and no export file
 * (`issues.jsonl`) is ever parsed or edited. There is deliberately no markdown
 * fallback — when the graph cannot be addressed the adapter raises a structured
 * error naming the path rather than quietly writing a backlog file.
 *
 * Measured against bd 1.3.0 (f45b249ce). The shapes this normalizer defends
 * against are frozen by `test/backends/beads.test.ts`; the load-bearing ones:
 *   - `bd show --json` returns an ARRAY of issues; `bd create --json` an object.
 *   - `dependencies` is absent when empty, and carries a DIFFERENT shape per
 *     command (`show`: nested issue + `dependency_type`; `list`: edge record
 *     with `depends_on_id` + `type`).
 *   - `started_at` / `closed_at` / `close_reason` materialize only once set.
 *   - `bd update -s open` CLEARS `closed_at` and `close_reason`, so completion
 *     evidence is mirrored into namespaced metadata to survive a reopen.
 *   - `bd delete` without `--force` exits 0 having deleted nothing.
 */

/** Flat, dotted, namespaced metadata keys. Beads treats them as literal keys. */
const META_KIND = "axi.kind";
const META_REPO = "axi.repo";
const META_HOLD = "axi.hold";
const META_CREATED = "axi.created";
const META_CLOSED = "axi.closed";
const META_DEP_REASONS = "axi.dep_reasons";
const META_FOLLOWUP = "axi.public_followup";
const META_BODY_ARCHIVE = "axi.body_archive";
const META_BAG = "axi.meta";

const STATE_TO_BD: Record<State, string> = {
  queued: "open",
  in_flight: "in_progress",
  done: "closed",
};

/**
 * Beads carries two stored statuses with no tasks-axi state of their own.
 * `blocked` and `deferred` both fold to `queued`: tasks-axi derives `blocked`
 * from the dependency graph and `held` from a structured hold, so folding them
 * here keeps a single source for those projections instead of two.
 */
const BD_TO_STATE: Record<string, State> = {
  open: "queued",
  in_progress: "in_flight",
  closed: "done",
  blocked: "queued",
  deferred: "queued",
};

const DEP_TO_BD: Record<DepType, string> = {
  "blocked-by": "blocks",
  parent: "parent-child",
  "discovered-from": "discovered-from",
};

/**
 * Only the three edge types tasks-axi models are surfaced. Beads' nonblocking
 * relations (`tracks`, `related`, `relates-to`, `until`, `caused-by`,
 * `validates`, `supersedes`) are deliberately NOT mapped: tasks-axi derives
 * `blocked`/`ready` from `deps`, so surfacing a nonblocking edge there would
 * make unrelated work read as blocked.
 */
const BD_TO_DEP: Record<string, DepType> = {
  blocks: "blocked-by",
  "parent-child": "parent",
  "discovered-from": "discovered-from",
};

const NOT_FOUND_MARKERS = ["not found", "no issues found matching"];

export interface BeadsRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Boundary: run one `bd` invocation. Injected in tests. */
export type BeadsRunner = (args: string[]) => Promise<BeadsRunResult>;

const execFileAsync = promisify(execFile);

/**
 * A `dependencies` payload nests a full issue record per edge, so a heavily
 * linked graph produces a large read. 64 MiB is far above any realistic
 * backlog while still bounding a runaway response.
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Bound a hung bd call rather than blocking a lifecycle operation forever. */
const BD_TIMEOUT_MS = 120_000;

export interface BeadsStoreOptions {
  /** The `.beads` directory of the owning repository. */
  path: string;
  /** The `bd` binary (default `bd`). */
  binary?: string;
  /** Issue prefix of the graph, enabling prefix-fallback id lookup. */
  prefix?: string;
  /** Injectable clock returning a YYYY-MM-DD stamp (for tests). */
  now?: () => string;
  /** Injectable `bd` runner (for tests). */
  run?: BeadsRunner;
}

interface BeadsRecord {
  id: string;
  title: string;
  status?: string;
  priority?: number;
  description?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  dependencies?: unknown;
}

function today(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** The YYYY-MM-DD prefix of an RFC3339 stamp, which is what tasks-axi renders. */
function datePart(stamp: string | undefined | null): string | undefined {
  if (!stamp) return undefined;
  const match = stamp.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function depKey(dep: { type: DepType; id: string }): string {
  return `${dep.type}:${dep.id}`;
}

/**
 * Normalize the two measured `dependencies` shapes into typed edges.
 *
 * `bd show --json` nests the full blocker issue and names the edge
 * `dependency_type`; `bd list --json` returns an edge record keyed
 * `depends_on_id` and names the edge `type`. Both are accepted so a caller
 * never has to know which command produced the record.
 */
function parseDependencies(
  raw: unknown,
  reasons: Record<string, unknown>,
): Dep[] {
  if (!Array.isArray(raw)) return [];
  const deps: Dep[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;
    const rawType = record.dependency_type ?? record.type;
    const rawId = record.depends_on_id ?? record.id;
    if (typeof rawType !== "string" || typeof rawId !== "string") continue;
    const type = BD_TO_DEP[rawType];
    if (!type) continue;
    const dep: Dep = { type, id: rawId };
    const reason = reasons[depKey(dep)];
    if (typeof reason === "string" && reason !== "") dep.reason = reason;
    deps.push(dep);
  }
  return deps;
}

export class BeadsStore implements Store {
  private readonly beadsDir: string;
  private readonly binary: string;
  private readonly prefix: string | undefined;
  private readonly now: () => string;
  private readonly runner: BeadsRunner | undefined;
  /** Why the last `removeRow` call returned false. */
  private lastRemovalDetail = "";

  constructor(options: BeadsStoreOptions) {
    this.beadsDir = options.path;
    this.binary = options.binary ?? "bd";
    this.prefix = options.prefix;
    this.now = options.now ?? today;
    this.runner = options.run;
  }

  capabilities(): Capabilities {
    return {
      backend: "beads",
      // Native typed edges, so ready/blocked derivation works unchanged.
      deps: true,
      // No prune: Beads keeps closed issues in the graph by design, and this
      // adapter never writes an archive file. Capability-gated, not silent.
      prune: false,
      // Beads has first-class comments, but the Store seam exposes no comment
      // verb, so advertising them would promise something the CLI cannot reach.
      comments: false,
      fullTextSearch: false,
      // Dolt sync is explicitly outside adapter calls: no `bd dolt push/pull`
      // runs here, so no lifecycle call can fail on network or credentials.
      realtimeSync: false,
      // Beads stores `blocked` and `deferred` beyond the three tasks-axi states.
      customStates: true,
      // Ids are always caller-supplied; `bd create --id` is passed every time.
      serverMintsIds: false,
      publicFollowups: true,
      // Graph-to-graph moves go through `transferMany`; see its own comment for
      // why a markdown destination is refused rather than exported.
      collectionTransfer: true,
    };
  }

  // -------------------------------------------------------------------------
  // bd invocation
  // -------------------------------------------------------------------------

  /**
   * Refuse rather than fall back. An unresolvable graph is a configuration
   * fault, and the one thing this adapter must never do is write a markdown
   * backlog instead.
   */
  private requireGraph(): void {
    if (this.runner) return;
    if (!existsSync(this.beadsDir) || !statSync(this.beadsDir).isDirectory()) {
      throw new AxiError(
        `Beads graph not found at ${this.beadsDir}`,
        "VALIDATION_ERROR",
        [
          `Set \`[beads] path = "<repo>/.beads"\` in .tasks.toml`,
          "There is no markdown fallback for the beads backend",
        ],
      );
    }
  }

  /**
   * The advisory-lock target for this graph, beside the graph directory so
   * every tasks-axi process addressing the same `.beads` serializes on the
   * same file (`lock.ts` appends `.lock`).
   */
  private get lockTarget(): string {
    return join(this.beadsDir, ".tasks-axi");
  }

  /**
   * Serialize ONE mutation against this graph.
   *
   * bd 1.3.0 offers compare-and-set guards for `status` and `assignee`
   * (`--if-status` / `--if-assignee`, exit 13) but none for a metadata
   * revision, and `revision` does not advance on an edge write — so no
   * conditional write can make a read-validate-write over namespaced metadata
   * safe, which is exactly what a public-followup revision bump is. bd's own
   * database lock only serializes ONE invocation, not the read and the write
   * either side of this adapter's validation, so an advisory lock held across
   * the WHOLE read-validate-write is the only sound primitive available.
   *
   * It is taken for every mutation rather than only the followup path:
   * mutations serialized against different locks are not serialized at all,
   * and `update`/`transition`/`addDep` all rewrite the same owned metadata
   * patch from a value they read earlier. Contention fails closed with
   * `LOCKED`, as the markdown backend does.
   *
   * Reads stay lock-free: a single-row read is already consistent, and
   * serializing reads would buy nothing a caller could rely on.
   *
   * The graph check comes FIRST. Acquiring the lock creates the directory it
   * would sit in, so locking before checking would turn "no graph here" into a
   * silent write beside a graph that does not exist.
   */
  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    this.requireGraph();
    return withLock(this.lockTarget, fn);
  }

  private async run(args: string[]): Promise<BeadsRunResult> {
    this.requireGraph();
    if (this.runner) return this.runner(args);
    // `-C` selects the repository root that owns the `.beads` directory; it is
    // bd's documented `git -C` equivalent and works from any cwd.
    const full = ["-C", dirname(this.beadsDir), ...args];
    try {
      const { stdout, stderr } = await execFileAsync(this.binary, full, {
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: BD_TIMEOUT_MS,
        env: {
          ...process.env,
          // bd otherwise stages its own export during a write, which can
          // orphan .git/index.lock, and adopts a Dolt remote from git origin.
          BD_EXPORT_GIT_ADD: "false",
          BD_NO_REMOTE_ADOPT: "1",
          BD_NO_DEP_TYPE_WARNING: "1",
        },
      });
      return { status: 0, stdout, stderr };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      // A missing binary (or a spawn failure) is a configuration fault, not a
      // bd-reported error: there is no exit status to interpret.
      if (typeof failure.code === "string" || failure.stdout === undefined) {
        throw new AxiError(
          `Could not run ${this.binary}: ${failure.message}`,
          "UNSUPPORTED",
          [`Install bd, or set \`[beads] binary = "<path>"\` in .tasks.toml`],
        );
      }
      if (failure.killed) {
        throw new AxiError(
          `bd timed out after ${BD_TIMEOUT_MS}ms`,
          "UNKNOWN",
          ["Retry, or check for a stuck Dolt lock on the graph"],
        );
      }
      return {
        status: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }
  }

  private mentionsNotFound(result: BeadsRunResult): boolean {
    const haystack = `${result.stdout}\n${result.stderr}`.toLowerCase();
    return NOT_FOUND_MARKERS.some((marker) => haystack.includes(marker));
  }

  private fail(action: string, result: BeadsRunResult): never {
    const detail = (result.stderr || result.stdout).trim().split("\n")[0];
    throw new AxiError(
      `bd ${action} failed: ${detail || `exit ${result.status}`}`,
      "UNKNOWN",
    );
  }

  /** Run a read and return the issue record, or null when the id is absent. */
  private async showRaw(id: string): Promise<BeadsRecord | null> {
    const result = await this.run(["show", id, "--json"]);
    if (result.status !== 0) {
      if (this.mentionsNotFound(result)) return null;
      this.fail(`show ${id}`, result);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new AxiError(
        `bd show ${id} did not return JSON`,
        "UNKNOWN",
        ["Check that the configured bd supports `--json` output"],
      );
    }
    // Measured: `show --json` returns an ARRAY, even for a single id.
    const records = Array.isArray(parsed) ? parsed : [parsed];
    const first = asRecord(records[0]);
    if (!first || typeof first.id !== "string") return null;
    return first as unknown as BeadsRecord;
  }

  /**
   * Resolve an id, applying the configured prefix as a documented fallback.
   * A literal hit always wins, so a prefixed graph can still hold a legacy
   * markdown id verbatim.
   */
  private async resolve(id: string): Promise<BeadsRecord | null> {
    const direct = await this.showRaw(id);
    if (direct) return direct;
    if (!this.prefix || id.startsWith(`${this.prefix}-`)) return null;
    return this.showRaw(`${this.prefix}-${id}`);
  }

  // -------------------------------------------------------------------------
  // Normalization
  // -------------------------------------------------------------------------

  private toTask(record: BeadsRecord): Task {
    const metadata = record.metadata ?? {};
    const reasons = asRecord(metadata[META_DEP_REASONS]) ?? {};
    const title = typeof record.title === "string" ? record.title : "";
    const task: Task = {
      id: record.id,
      title,
      state: BD_TO_STATE[record.status ?? "open"] ?? "queued",
      links: deriveLinks(title),
      deps: parseDependencies(record.dependencies, reasons),
    };

    const kind = metadata[META_KIND];
    if (typeof kind === "string" && kind !== "") task.kind = kind;
    const repo = metadata[META_REPO];
    if (typeof repo === "string" && repo !== "") task.repo = repo;
    if (typeof record.description === "string" && record.description !== "") {
      task.body = record.description;
    }

    const hold = asRecord(metadata[META_HOLD]);
    if (hold && typeof hold.reason === "string") {
      const parsed: Hold = { reason: hold.reason };
      if (typeof hold.kind === "string") {
        parsed.kind = hold.kind as Hold["kind"];
      }
      if (typeof hold.until === "string") parsed.until = hold.until;
      task.hold = parsed;
    }

    if (typeof record.priority === "number") task.priority = record.priority;

    // `axi.created`/`axi.closed` are authoritative: bd clears `closed_at` on a
    // reopen, so the original completion stamp only survives in metadata.
    const created = metadata[META_CREATED];
    const createdStamp =
      typeof created === "string" ? created : datePart(record.created_at);
    if (createdStamp && task.state !== "done") task.created = createdStamp;
    else if (createdStamp) task.created = createdStamp;

    const updated = datePart(record.updated_at);
    if (updated) task.updated = updated;

    const closed = metadata[META_CLOSED];
    const closedStamp =
      typeof closed === "string" ? closed : datePart(record.closed_at);
    if (closedStamp && task.state === "done") task.closed = closedStamp;

    const followup = metadata[META_FOLLOWUP];
    if (typeof followup === "string" && followup !== "") {
      task.public_followup = decodePublicFollowup(followup);
    }

    const bag = asRecord(metadata[META_BAG]);
    if (bag) task.meta = { ...bag };

    return task;
  }

  /**
   * The owned-key patch for one write, merged by bd into existing metadata.
   * `extra` is applied LAST so a caller can override an owned key — the
   * completion stamp relies on that to survive a reopen.
   */
  private metaPatch(task: Task, extra: Record<string, unknown> = {}): string {
    const patch: Record<string, unknown> = {};
    patch[META_KIND] = task.kind ?? null;
    patch[META_REPO] = task.repo ?? null;
    patch[META_HOLD] = task.hold ?? null;
    patch[META_CREATED] = task.created ?? null;
    patch[META_CLOSED] = task.closed ?? null;
    patch[META_BAG] = task.meta ?? null;
    patch[META_FOLLOWUP] = task.public_followup
      ? encodePublicFollowup(task.public_followup)
      : null;
    const reasons: Record<string, string> = {};
    for (const dep of task.deps) {
      if (dep.reason) reasons[depKey(dep)] = dep.reason;
    }
    patch[META_DEP_REASONS] =
      Object.keys(reasons).length > 0 ? reasons : null;
    return JSON.stringify({ ...patch, ...extra });
  }

  /**
   * The `--metadata` flags for ONE `bd` write.
   *
   * Every owned key is always sent, and a key whose value is now absent is
   * sent as an explicit JSON `null`. Two measured bd 1.3.0 constraints force
   * that shape rather than `--unset-metadata`:
   *   - `bd create` has no `--unset-metadata` at all (it is `bd update`'s).
   *   - `bd update` REFUSES to combine `--metadata` with `--unset-metadata`
   *     ("cannot combine ..."), so clearing one key while setting another
   *     would take two invocations — and a hold or a public-followup
   *     completion must not be observable half-written.
   *
   * The cost is a tombstone: the key survives holding `null` instead of
   * disappearing. Readers treat a null as absent, so the Task model is
   * unaffected.
   */
  private metaFlags(task: Task, extra: Record<string, unknown> = {}): string[] {
    return ["--metadata", this.metaPatch(task, extra)];
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async get(id: string): Promise<Task | null> {
    const record = await this.resolve(id);
    return record ? this.toTask(record) : null;
  }

  async list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
    // `--limit 0` is unlimited; bd's default of 50 would silently truncate the
    // backlog, and tasks-axi derives ready/blocked/held from the whole set.
    const args = ["list", "--json", "--limit", "0"];
    if (query.state) args.push("--status", STATE_TO_BD[query.state]);
    const result = await this.run(args);
    if (result.status !== 0) this.fail("list", result);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout || "[]");
    } catch {
      throw new AxiError("bd list did not return JSON", "UNKNOWN");
    }
    const records = Array.isArray(parsed) ? parsed : [];
    let items = records
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .filter((entry) => typeof entry.id === "string")
      .map((entry) => this.toTask(entry as unknown as BeadsRecord));

    // `repo`/`kind` live in namespaced metadata, which bd cannot filter on, so
    // they are applied here rather than pushed down.
    if (query.repo) items = items.filter((task) => task.repo === query.repo);
    if (query.kind) items = items.filter((task) => task.kind === query.kind);
    const total = items.length;
    if (query.limit !== undefined && query.limit >= 0) {
      items = items.slice(0, query.limit);
    }
    return { items, total };
  }

  // -------------------------------------------------------------------------
  // Mutations
  //
  // Every public mutator is a thin wrapper that takes the graph's advisory
  // lock once and delegates to an `*Unlocked` body. The bodies call each other
  // directly (a transfer stages rows in the destination), so re-entering
  // through a public verb would deadlock on a lock this call already holds.
  // -------------------------------------------------------------------------

  async create(input: TaskInput): Promise<Task> {
    return this.mutate(() => this.createUnlocked(input));
  }

  async update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
    return this.mutate(() => this.updateUnlocked(id, patch));
  }

  async remove(id: string): Promise<Task> {
    return this.mutate(() => this.removeUnlocked(id));
  }

  async transition(
    id: string,
    to: State,
    opts: TransitionOpts = {},
  ): Promise<Task> {
    return this.mutate(() => this.transitionUnlocked(id, to, opts));
  }

  async updatePublicFollowup(
    id: string,
    mutation: PublicFollowupMutation,
  ): Promise<Task> {
    return this.mutate(() => this.updatePublicFollowupUnlocked(id, mutation));
  }

  async addDep(id: string, dep: Dep): Promise<boolean> {
    return this.mutate(() => this.addDepUnlocked(id, dep));
  }

  async removeDep(id: string, dep: Dep): Promise<boolean> {
    return this.mutate(() => this.removeDepUnlocked(id, dep));
  }

  async transferMany(ids: string[], destination: Store): Promise<Task[]> {
    if (!(destination instanceof BeadsStore)) {
      throw new AxiError(
        `The beads backend can only transfer tasks into another beads graph, not "${destination.capabilities().backend}"`,
        "UNSUPPORTED",
        ["Point --to at a repository holding a .beads directory"],
      );
    }
    this.requireGraph();
    destination.requireGraph();
    // Both graphs are locked for the whole transfer. `withLocks` orders them by
    // resolved path, so two transfers in opposite directions cannot deadlock,
    // and dedupes, so a graph transferring to itself takes one lock rather
    // than blocking on itself.
    return withLocks([this.lockTarget, destination.lockTarget], () =>
      this.transferManyUnlocked(ids, destination),
    );
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  private taskFromInput(input: TaskInput): Task {
    const id = validateId(input.id);
    const state: State = input.state ?? "queued";
    let title = normalizeTitle(input.title);
    const kind = normalizeTagValue(input.kind, "kind");
    const repo = normalizeTagValue(input.repo, "repo");
    for (const link of input.links ?? []) {
      title = appendTitleLink(title, link);
    }
    const task: Task = {
      id,
      title,
      state,
      links: deriveLinks(title),
      deps: input.deps ? input.deps.map((dep) => normalizeDep(id, dep)) : [],
    };
    if (kind) task.kind = kind;
    if (repo) task.repo = repo;
    if (input.body) task.body = input.body;
    const hold = normalizeHold(input.hold);
    if (hold) task.hold = hold;
    const priority = normalizePriority(input.priority);
    if (priority !== undefined) task.priority = priority;
    if (kind === PUBLIC_FOLLOWUP_KIND) {
      if (task.hold) {
        throw new AxiError(
          "Public-followup obligations cannot use dispatch holds",
          "VALIDATION_ERROR",
        );
      }
      if (!input.public_followup) {
        throw new AxiError(
          "kind=public-followup requires typed public_followup data",
          "VALIDATION_ERROR",
          ["Use `tasks-axi public-followup add ...`"],
        );
      }
      const publicFollowup = normalizePublicFollowup(input.public_followup);
      assertPublicFollowupTaskState(state, publicFollowup, id);
      task.public_followup = publicFollowup;
    } else if (input.public_followup) {
      throw new AxiError(
        "Typed public_followup data requires kind=public-followup",
        "VALIDATION_ERROR",
      );
    }
    if (input.meta) task.meta = input.meta;
    if (input.created !== undefined) {
      if (input.created !== null) {
        task.created = normalizeDate(input.created, "created date");
      }
    } else if (state !== "done") {
      task.created = normalizeDate(this.now(), "created date");
    }
    if (input.closed !== undefined) {
      task.closed = normalizeDate(input.closed, "closed date");
    }
    return task;
  }

  private async createUnlocked(input: TaskInput): Promise<Task> {
    const task = this.taskFromInput(input);
    if (await this.resolve(task.id)) {
      throw new AxiError(`Task "${task.id}" already exists`, "CONFLICT");
    }
    // Mirrors the markdown backend: a dangling edge is refused before any write.
    for (const dep of task.deps) {
      if (await this.resolve(dep.id)) continue;
      const label = dep.type === "blocked-by" ? "blocker" : "dependency";
      throw new AxiError(`${label} "${dep.id}" not found`, "VALIDATION_ERROR", [
        "Create the dependency task first, or choose an existing task id",
      ]);
    }

    const args = [
      "create",
      task.title,
      "--id",
      task.id,
      // tasks-axi ids are arbitrary slugs; bd refuses an id whose prefix does
      // not match the database prefix unless forced. Id fidelity wins here —
      // the join key must survive verbatim.
      "--force",
      "--status",
      STATE_TO_BD[task.state],
      "--json",
    ];
    if (task.priority !== undefined) {
      args.push("--priority", String(task.priority));
    }
    if (task.body !== undefined) args.push("--description", task.body);
    args.push(...this.metaFlags(task));

    const result = await this.run(args);
    if (result.status !== 0) this.fail(`create ${task.id}`, result);

    for (const dep of task.deps) {
      await this.writeDep(task.id, dep);
    }
    return task;
  }

  private async updateUnlocked(
    id: string,
    patch: TaskPatch,
  ): Promise<TaskUpdateResult> {
    const record = await this.resolve(id);
    if (!record) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    const task = this.toTask(record);

    if (
      isPublicFollowupTask(task) &&
      (patch.title !== undefined ||
        patch.body !== undefined ||
        patch.archiveBody ||
        (patch.addBodyLines?.length ?? 0) > 0 ||
        (patch.addLinks?.length ?? 0) > 0 ||
        patch.hold !== undefined)
    ) {
      throw new AxiError(
        "Public-followup content and holds cannot change through generic update",
        "VALIDATION_ERROR",
        ["Create a successor obligation when the public promise changes"],
      );
    }

    const nextBody =
      patch.body !== undefined ? patch.body || undefined : task.body;
    const supersededBody =
      patch.archiveBody && patch.body !== undefined && task.body !== nextBody
        ? task.body
        : undefined;

    const changed: TaskUpdateChange[] = [];
    const markChanged = (field: TaskUpdateChange) => {
      if (!changed.includes(field)) changed.push(field);
    };

    if (patch.title !== undefined) {
      const title = normalizeTitle(patch.title);
      if (task.title !== title) {
        task.title = title;
        markChanged("title");
      }
    }
    if (patch.body !== undefined && task.body !== nextBody) {
      task.body = nextBody;
      markChanged("body");
    }
    for (const line of patch.addBodyLines ?? []) {
      if (line !== "" && !bodyHasLine(task.body, line)) {
        task.body = task.body ? `${task.body}\n${line}` : line;
        markChanged("body");
      }
    }
    if (patch.repo !== undefined) {
      const repo = normalizeTagValue(patch.repo, "repo");
      if (task.repo !== repo) {
        if (repo === undefined) delete task.repo;
        else task.repo = repo;
        markChanged("repo");
      }
    }
    if (patch.kind !== undefined) {
      const kind = normalizeTagValue(patch.kind, "kind");
      if (task.kind === PUBLIC_FOLLOWUP_KIND || kind === PUBLIC_FOLLOWUP_KIND) {
        throw new AxiError(
          "Public-followup kind cannot be changed through generic update",
          "VALIDATION_ERROR",
          ["Use the dedicated `tasks-axi public-followup` commands"],
        );
      }
      if (task.kind !== kind) {
        if (kind === undefined) delete task.kind;
        else task.kind = kind;
        markChanged("kind");
      }
    }
    if (patch.hold !== undefined) {
      const hold = normalizeHold(patch.hold ?? undefined);
      if (!sameHold(task.hold, hold)) {
        if (hold) task.hold = hold;
        else delete task.hold;
        markChanged("hold");
      }
    }
    if (patch.priority !== undefined) {
      const priority = normalizePriority(patch.priority);
      if (task.priority !== priority) {
        task.priority = priority;
        markChanged("priority");
      }
    }
    if (patch.meta) {
      const meta = { ...task.meta, ...patch.meta };
      if (!sameMeta(task.meta, meta)) {
        task.meta = meta;
        markChanged("meta");
      }
    }
    for (const link of patch.addLinks ?? []) {
      const title = appendTitleLink(task.title, link);
      if (task.title !== title) {
        task.title = title;
        markChanged("links");
      }
    }

    if (changed.length === 0) return { task, changed };

    task.links = deriveLinks(task.title);
    task.updated = this.now();

    const extra: Record<string, unknown> = {};
    if (supersededBody !== undefined) {
      // No archive FILE exists for a graph store, so the superseded body is
      // kept recoverably in namespaced metadata instead.
      const existing = record.metadata?.[META_BODY_ARCHIVE];
      const history = Array.isArray(existing) ? existing : [];
      extra[META_BODY_ARCHIVE] = [
        ...history,
        { archived: this.now(), body: supersededBody },
      ];
      markChanged("archive");
    }

    const args = ["update", record.id, "--title", task.title];
    if (task.priority !== undefined) {
      args.push("--priority", String(task.priority));
    }
    if (changed.includes("body") || changed.includes("archive")) {
      args.push("--description", task.body ?? "", "--allow-empty-description");
    }
    args.push(...this.metaFlags(task, extra));

    const result = await this.run(args);
    if (result.status !== 0) this.fail(`update ${record.id}`, result);
    return { task, changed };
  }

  private async removeUnlocked(id: string): Promise<Task> {
    const record = await this.resolve(id);
    if (!record) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    const task = this.toTask(record);

    if (
      isPublicFollowupTask(task) &&
      task.public_followup &&
      !isPublicFollowupTerminal(task.public_followup)
    ) {
      throw new AxiError(
        "Active public-followup obligations cannot be removed",
        "VALIDATION_ERROR",
        ["Record a posted receipt or Captain-approved waiver first"],
      );
    }

    // Measured on bd 1.3.0: `bd delete --force` deletes an issue that still has
    // dependents and silently drops their edges, despite its own help claiming
    // the default refuses. The guard therefore lives HERE, before the delete.
    const dependents = await this.activeDependents(record.id);
    if (dependents.length > 0) {
      throw new AxiError(
        `Task "${id}" is still blocking active tasks: ${dependents.join(", ")}`,
        "VALIDATION_ERROR",
        [
          `Unblock them first, e.g. \`tasks-axi unblock ${dependents[0]} --by ${id}\``,
        ],
      );
    }

    if (!(await this.removeRow(record.id))) {
      throw new AxiError(
        `bd delete ${record.id} failed: ${this.lastRemovalDetail}`,
        "UNKNOWN",
      );
    }
    return task;
  }

  private async activeDependents(id: string): Promise<string[]> {
    const { items } = await this.list({});
    return items
      .filter(
        (task) =>
          task.state !== "done" &&
          task.deps.some((dep) => dep.type === "blocked-by" && dep.id === id),
      )
      .map((task) => task.id);
  }

  // -------------------------------------------------------------------------
  // State + dependencies
  // -------------------------------------------------------------------------

  private async transitionUnlocked(
    id: string,
    to: State,
    opts: TransitionOpts,
  ): Promise<Task> {
    const record = await this.resolve(id);
    if (!record) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    const task = this.toTask(record);

    if (isPublicFollowupTask(task)) {
      throw new AxiError(
        "Public-followup state cannot change through generic transitions",
        "VALIDATION_ERROR",
        [
          "Use `tasks-axi public-followup record-delivery` or `tasks-axi public-followup waive`",
        ],
      );
    }
    const date = normalizeDate(opts.date ?? this.now(), "transition date");

    const transitionLinks: TaskLink[] = [];
    if (opts.pr !== undefined) transitionLinks.push({ kind: "pr", url: opts.pr });
    if (opts.report !== undefined) {
      transitionLinks.push({ kind: "report", url: opts.report });
    }
    for (const link of transitionLinks) {
      task.title = appendTitleLink(task.title, link);
    }
    if (opts.note) {
      task.body = task.body ? `${task.body}\n${opts.note}` : opts.note;
    }
    task.links = deriveLinks(task.title);

    // The durable completion stamp, independent of the current state. bd clears
    // its own closed_at on reopen, so this namespaced value is the only record
    // of when the work originally completed.
    const priorClosed = record.metadata?.[META_CLOSED];
    const closedEvidence =
      typeof priorClosed === "string" ? priorClosed : task.closed;

    task.state = to;
    if (to === "done") {
      // Idempotent evidence backfill: a repeat completion keeps the ORIGINAL
      // close date rather than restamping it.
      task.closed = closedEvidence ?? date;
    } else {
      if (to === "in_flight" && !task.created) task.created = date;
      // `Task.closed` is only surfaced for done work, but the evidence itself
      // is retained below so a reopen does not lose it.
      delete task.closed;
    }
    task.updated = this.now();

    const args = [
      "update",
      record.id,
      "--status",
      STATE_TO_BD[to],
      "--title",
      task.title,
      // tasks-axi's `done` is a plain state move; bd otherwise refuses to close
      // an issue with open children or a live blocker.
      "--force",
    ];
    if (task.body !== undefined) {
      args.push("--description", task.body, "--allow-empty-description");
    }
    args.push(
      ...this.metaFlags(task, {
        [META_CLOSED]: closedEvidence ?? (to === "done" ? date : null),
      }),
    );

    const result = await this.run(args);
    if (result.status !== 0) this.fail(`transition ${record.id}`, result);
    return task;
  }

  private async updatePublicFollowupUnlocked(
    id: string,
    mutation: PublicFollowupMutation,
  ): Promise<Task> {
    const record = await this.resolve(id);
    if (!record) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    const task = this.toTask(record);

    if (!isPublicFollowupTask(task) || !task.public_followup) {
      throw new AxiError(
        `Task "${id}" is not a public-followup obligation`,
        "VALIDATION_ERROR",
      );
    }
    const expected = normalizePublicFollowup(mutation.expectedPublicFollowup);
    if (
      task.public_followup.revision !== mutation.expectedRevision ||
      expected.revision !== mutation.expectedRevision ||
      !canonicalEqual(task.public_followup, expected)
    ) {
      throw new AxiError(
        `Public-followup "${id}" changed; retry the command`,
        "CONFLICT",
        ["Read the latest obligation revision, then retry"],
      );
    }
    if (task.state === "done") {
      throw new AxiError(
        `Public-followup "${id}" is already complete`,
        "CONFLICT",
      );
    }
    if (mutation.requireUnblocked) {
      const { items } = await this.list({});
      const byId = new Map(items.map((item) => [item.id, item]));
      const blocked = task.deps.some((dep) => {
        if (dep.type !== "blocked-by") return false;
        const blocker = byId.get(dep.id);
        return blocker !== undefined && blocker.state !== "done";
      });
      if (blocked) {
        throw new AxiError(
          "Cannot begin delivery while the obligation has an active blocker",
          "VALIDATION_ERROR",
        );
      }
    }

    const next = normalizePublicFollowup(mutation.publicFollowup);
    assertPublicFollowupMutation(task.public_followup, next);
    if (mutation.complete && !isPublicFollowupTerminal(next)) {
      throw new AxiError(
        "Only a posted receipt or Captain-approved waiver may complete a public-followup",
        "VALIDATION_ERROR",
      );
    }
    if (!mutation.complete && isPublicFollowupTerminal(next)) {
      throw new AxiError(
        "Terminal public-followup data requires an atomic completion mutation",
        "VALIDATION_ERROR",
      );
    }

    task.public_followup = next;
    task.updated = this.now();
    const args = ["update", record.id];
    if (mutation.complete) {
      task.state = "done";
      task.closed = normalizeDate(this.now(), "transition date");
      args.push("--status", STATE_TO_BD.done, "--force");
    }
    assertPublicFollowupTaskState(task.state, next, id);
    // The whole obligation revision and the completion travel in ONE bd write,
    // so a reader never observes a half-applied delivery.
    args.push(...this.metaFlags(task));

    const result = await this.run(args);
    if (result.status !== 0) {
      this.fail(`public-followup ${record.id}`, result);
    }
    return task;
  }

  private async writeDep(id: string, dep: Dep): Promise<void> {
    const result = await this.run([
      "dep",
      "add",
      id,
      dep.id,
      "--type",
      DEP_TO_BD[dep.type],
    ]);
    if (result.status !== 0) this.fail(`dep add ${id} ${dep.id}`, result);
  }

  private async addDepUnlocked(id: string, dep: Dep): Promise<boolean> {
    const checkedDep = normalizeDep(id, dep);
    const record = await this.resolve(id);
    if (!record) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    const task = this.toTask(record);

    if (
      task.public_followup &&
      !["intent", "pending-work", "ready"].includes(
        task.public_followup.delivery.state,
      )
    ) {
      throw new AxiError(
        "Cannot add blockers after public delivery has started",
        "VALIDATION_ERROR",
      );
    }
    if (
      task.deps.some(
        (existing) =>
          existing.type === checkedDep.type && existing.id === checkedDep.id,
      )
    ) {
      return false;
    }
    // bd stores at most one relationship type per task pair and refuses a
    // second; surface that as a clear conflict instead of a raw bd error.
    // Restored from PR #52, whose own test froze the behaviour.
    const conflicting = task.deps.find(
      (existing) =>
        existing.id === checkedDep.id && existing.type !== checkedDep.type,
    );
    if (conflicting) {
      throw new AxiError(
        `Task "${id}" already has a ${conflicting.type} edge to "${checkedDep.id}", and bd stores one relationship type per task pair`,
        "VALIDATION_ERROR",
        [
          conflicting.type === "blocked-by"
            ? `Remove the existing edge first with \`tasks-axi unblock ${id} --by ${checkedDep.id}\``
            : `Remove the existing edge first with \`bd dep remove ${id} ${checkedDep.id}\``,
        ],
      );
    }
    if (!(await this.resolve(checkedDep.id))) {
      const label = checkedDep.type === "blocked-by" ? "blocker" : "dependency";
      throw new AxiError(
        `${label} "${checkedDep.id}" not found`,
        "VALIDATION_ERROR",
        ["Create the dependency task first, or choose an existing task id"],
      );
    }

    await this.writeDep(record.id, checkedDep);
    if (checkedDep.reason) {
      task.deps.push(checkedDep);
      const flags = this.metaFlags(task);
      const result = await this.run(["update", record.id, ...flags]);
      if (result.status !== 0) this.fail(`dep reason ${record.id}`, result);
    }
    return true;
  }

  private async removeDepUnlocked(id: string, dep: Dep): Promise<boolean> {
    const checkedDep: Dep = { ...dep, id: validateDependencyId(dep.id) };
    const record = await this.resolve(id);
    if (!record) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    const task = this.toTask(record);

    if (
      !task.deps.some(
        (existing) =>
          existing.type === checkedDep.type && existing.id === checkedDep.id,
      )
    ) {
      return false;
    }
    const result = await this.run(["dep", "remove", record.id, checkedDep.id]);
    if (result.status !== 0) {
      this.fail(`dep remove ${record.id} ${checkedDep.id}`, result);
    }
    task.deps = task.deps.filter(
      (existing) =>
        !(existing.type === checkedDep.type && existing.id === checkedDep.id),
    );
    const flags = this.metaFlags(task);
    const cleanup = await this.run(["update", record.id, ...flags]);
    if (cleanup.status !== 0) this.fail(`dep reason ${record.id}`, cleanup);
    return true;
  }

  /**
   * `Store.transferMany`. A Beads graph can only transfer into another Beads
   * graph: the destination must keep the same kind of record, so a markdown
   * backlog is refused by name rather than exported into — writing a task out
   * of the authoritative graph and into a `.md` file is the one thing this
   * adapter must never do.
   *
   * Two Dolt graphs cannot share one transaction, so this is NOT literally
   * atomic and does not claim to be. It is ordered and recoverable:
   *
   *  1. Every destination row is staged first. Any refusal or error in that
   *     phase rolls the whole staging back, leaving the SOURCE untouched.
   *  2. Only then are the source rows removed, dependents before blockers, so
   *     the adapter's own active-dependents guard never trips on a row whose
   *     dependent is already gone. Each removal is PROVED by reading the row
   *     back, not inferred from an exit status.
   *  3. A failed removal stops the loop. Every source row not yet removed is
   *     left intact, the destination copies of those same ids are rolled back,
   *     and `splitTransferError` names which ids are now only in the
   *     destination, only in the source, or (rollback refused) in both — so an
   *     operator can finish or revert the move by hand.
   */
  private async transferManyUnlocked(
    ids: string[],
    destination: BeadsStore,
  ): Promise<Task[]> {
    const uniqueIds = [...new Set(ids)];

    const tasks: Task[] = [];
    for (const id of uniqueIds) {
      const record = await this.resolve(id);
      if (!record) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
      tasks.push(this.toTask(record));
    }
    const moved = new Set(tasks.map((task) => task.id));

    for (const id of uniqueIds) {
      if (await destination.get(id)) {
        throw new AxiError(
          `Task "${id}" already exists in the destination backlog`,
          "CONFLICT",
        );
      }
    }
    await this.requireNoSplitDeps(destination, moved, tasks);

    // Stage the whole set in the destination WITHOUT its edges first: a
    // dependent may be created before its blocker, and `create` refuses a
    // dangling edge. The edges are written once every endpoint exists.
    const staged: string[] = [];
    try {
      for (const task of tasks) {
        await destination.createUnlocked(taskToInput({ ...task, deps: [] }));
        staged.push(task.id);
      }
      for (const task of tasks) {
        for (const dep of task.deps) {
          await destination.addDepUnlocked(task.id, dep);
        }
      }
    } catch (error) {
      // Nothing has left the source yet, so the whole staged set is discarded
      // and the source is left exactly as it was.
      const stuck = await destination.discardStaged(staged);
      if (stuck.length > 0) {
        throw rollbackResidueError(
          error,
          stuck,
          this.beadsDir,
          destination.beadsDir,
        );
      }
      throw error;
    }

    // Phase two: remove the source rows. A failure here STOPS the loop rather
    // than widening the split: every source row not yet removed is left
    // intact, the destination copies of those same ids are rolled back, and
    // the raised error names which ids now live where.
    const movedOnly: string[] = [];
    for (const task of this.removalOrder(tasks)) {
      if (await this.removeRow(task.id)) {
        movedOnly.push(task.id);
        continue;
      }
      const rollback = staged.filter((id) => !movedOnly.includes(id));
      const stuck = await destination.discardStaged(rollback);
      throw splitTransferError({
        failed: task.id,
        detail: this.lastRemovalDetail,
        source: this.beadsDir,
        destination: destination.beadsDir,
        movedOnly,
        returned: rollback.filter((id) => !stuck.includes(id)),
        stuck,
      });
    }
    return tasks;
  }

  /**
   * Delete one row and PROVE it is gone. `--force` is mandatory (bd exits 0
   * having deleted nothing without it) and the exit status alone still does not
   * prove deletion, so the row's absence is read back before the caller may
   * treat the id as removed. Returns false, with `lastRemovalDetail` set, so a
   * caller can compensate rather than catch.
   */
  private async removeRow(id: string): Promise<boolean> {
    let result: BeadsRunResult;
    try {
      result = await this.run(["delete", id, "--force"]);
    } catch (error) {
      this.lastRemovalDetail =
        error instanceof Error ? error.message : String(error);
      return false;
    }
    if (result.status === 0 && (await this.resolve(id)) === null) return true;
    this.lastRemovalDetail =
      (result.stderr || result.stdout).trim().split("\n")[0] ||
      (result.status === 0
        ? "bd delete exited 0 but the row is still in the graph"
        : `bd delete exited ${result.status}`);
    return false;
  }

  /**
   * The graph-store form of the markdown backend's split-dependency guard: no
   * transfer may leave a dependency edge pointing across the two graphs.
   */
  private async requireNoSplitDeps(
    destination: BeadsStore,
    moved: Set<string>,
    tasks: Task[],
  ): Promise<void> {
    const { items } = await this.list({});
    for (const id of moved) {
      const stranded = items
        .filter(
          (task) =>
            !moved.has(task.id) &&
            task.state !== "done" &&
            task.deps.some((dep) => dep.type === "blocked-by" && dep.id === id),
        )
        .map((task) => task.id);
      if (stranded.length > 0) throw stillBlockingError(id, stranded);
    }
    for (const task of tasks) {
      for (const dep of task.deps) {
        if (moved.has(dep.id)) continue;
        if (await destination.get(dep.id)) continue;
        throw strandedDepError(task.id, dep);
      }
    }
  }

  /**
   * Undo staged destination rows. Returns the ids it could NOT remove — a
   * rollback delete can fail or silently delete nothing, and an unread result
   * would report a clean undo while leaving the task in both graphs, so the
   * residue is handed back for the caller to name in its error.
   */
  private async discardStaged(staged: string[]): Promise<string[]> {
    const stuck: string[] = [];
    for (const id of [...staged].reverse()) {
      if (!(await this.removeRow(id))) stuck.push(id);
    }
    return stuck;
  }

  /**
   * Dependents before blockers, so removing the set never asks the graph to
   * drop a row something still active depends on.
   */
  private removalOrder(tasks: Task[]): Task[] {
    const ordered: Task[] = [];
    const seen = new Set<string>();
    const visit = (task: Task): void => {
      if (seen.has(task.id)) return;
      seen.add(task.id);
      for (const other of tasks) {
        const dependsOnTask = other.deps.some(
          (dep) => dep.type === "blocked-by" && dep.id === task.id,
        );
        if (dependsOnTask) visit(other);
      }
      ordered.push(task);
    };
    for (const task of tasks) visit(task);
    return ordered;
  }

  // `prune` and `render` are intentionally absent: both are optional and
  // capability-gated, so the CLI names the missing capability instead of this
  // adapter inventing an archive file beside an authoritative graph.
}
