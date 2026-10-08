import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import { isLocked } from "../../src/backends/lock.js";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { mvCommand } from "../../src/commands/state.js";
import { AxiError } from "../../src/errors.js";
import { decodePublicFollowup } from "../../src/public-followup.js";
import type { DepType, State } from "../../src/model.js";
import type { Store } from "../../src/store.js";
import {
  parseConfigToml,
  resolveConfig,
  type ResolvedConfig,
} from "../../src/config.js";
import {
  resolveTasksContext,
  type TasksContext,
} from "../../src/context.js";
import { bdAvailability } from "../beads-helpers.js";

/**
 * Contract tests for the Beads-backed store (AIH-nta1e).
 *
 * These run against a DISPOSABLE Beads graph created in a temp directory and
 * freeze the Task-to-Beads mapping table as executable assertions. Every
 * mapping assertion reads the stored Beads record back through `bd` itself, so
 * a mapping claim is checked against the real store rather than against this
 * adapter's own normalizer.
 *
 * The graph is created with the store-only `bd init` invocation the fleet
 * wrapper uses (`--skip-agents --skip-hooks --non-interactive`), which keeps bd
 * from injecting per-repo context files or seizing core.hooksPath. The graph is
 * embedded and local: no Dolt server is contacted.
 */

// Each case drives several real `bd` invocations against an embedded Dolt
// store; the 5s default is a harness limit, not a contract. So is this one: the
// cross-graph cases each `bd init` two graphs, and the slowest of them measured
// 33s with this file running alone and timed out at the previous 60s under the
// whole suite's parallelism on a loaded host.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const BD_ENV = {
  ...process.env,
  BD_EXPORT_GIT_ADD: "false",
  BD_NO_REMOTE_ADOPT: "1",
  BD_NO_DEP_TYPE_WARNING: "1",
};

function hasBd(): boolean {
  const probe = spawnSync("bd", ["version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
}

// `REQUIRE_BD=1` (what CI sets) turns the self-skip below into a hard
// failure, so a broken bd install or a PATH regression cannot silently
// drop this whole file's coverage and still report green.
const BD_AVAILABLE = bdAvailability(hasBd, process.env);

interface Graph {
  repo: string;
  beadsDir: string;
}

function makeGraph(): Graph {
  const repo = mkdtempSync(join(tmpdir(), "tasks-axi-beads-"));
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "spike@local"]);
  git(["config", "user.name", "Spike"]);
  const init = spawnSync(
    "bd",
    [
      "init",
      "--prefix",
      "SPIKE",
      "--skip-agents",
      "--skip-hooks",
      "--non-interactive",
    ],
    { cwd: repo, encoding: "utf8", env: BD_ENV },
  );
  if (init.status !== 0) {
    throw new Error(`bd init failed: ${init.stderr || init.stdout}`);
  }
  return { repo, beadsDir: join(repo, ".beads") };
}

/** Read a raw Beads record straight from bd, bypassing the adapter. */
function rawShow(graph: Graph, id: string): Record<string, unknown> {
  const result = spawnSync(
    "bd",
    ["-C", graph.repo, "show", id, "--json"],
    { encoding: "utf8", env: BD_ENV },
  );
  if (result.status !== 0) {
    throw new Error(`bd show ${id} failed: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout);
  return (Array.isArray(parsed) ? parsed[0] : parsed) as Record<
    string,
    unknown
  >;
}

function metadataOf(graph: Graph, id: string): Record<string, unknown> {
  return (rawShow(graph, id).metadata ?? {}) as Record<string, unknown>;
}

/**
 * Does bd itself still hold the row? `rawShow` cannot answer this: it throws
 * on a missing id, and a deletion has to be proved against the store rather
 * than against the adapter that claims to have performed it.
 */
function rawExists(graph: Graph, id: string): boolean {
  const result = spawnSync("bd", ["-C", graph.repo, "show", id, "--json"], {
    encoding: "utf8",
    env: BD_ENV,
  });
  return result.status === 0 && result.stdout.includes(`"${id}"`);
}

/**
 * One valid obligation fixture, shared by the mapping suite and the
 * concurrency suite below.
 */
const FOLLOWUP = {
  schema_version: 1 as const,
  revision: 1,
  request: {
    request_id: "req-public-demo",
    platform: "discord" as const,
    context_binding: { version: "ctx1" as const, value: "ctx1_opaque_demo" },
    public_safe_summary: "Follow up when the public-safe fix ships",
    received_at: "2026-07-13T12:00:00Z",
    followup_expires_at: "2026-08-13T12:00:00Z",
    reservation_expires_at: "2026-09-13T12:00:00Z",
  },
  purpose: "promised-final" as const,
  expected_final: {
    type: "pr-merged" as const,
    project: "demo",
    required_deliverables: ["pr_url"],
    completion_policy: "all-required" as const,
  },
  obligation_expires_at: "2026-08-13T12:00:00Z",
  delivery: {
    state: "intent" as const,
    delivery_key: "fd1_demo",
    payload_digest: null,
    attempt_count: 0,
    last_error_code: null,
    next_attempt_at: null,
    receipt: null,
    last_error: null,
    waiver: null,
  },
  work_relations: [],
  lineage: {
    predecessor_obligation_id: null,
    successor_obligation_id: null,
  },
};

describe.skipIf(!BD_AVAILABLE)("BeadsStore against a disposable graph", () => {
  let graph: Graph;
  let store: BeadsStore;

  beforeAll(() => {
    graph = makeGraph();
    store = new BeadsStore({
      path: graph.beadsDir,
      binary: "bd",
      now: () => "2026-07-01",
    });
  }, 120_000);

  afterAll(() => {
    if (graph?.repo) rmSync(graph.repo, { recursive: true, force: true });
  });

  it("test_capabilities_when_beads_backend_then_deps_and_custom_states_true", () => {
    const caps = store.capabilities();
    expect(caps.backend).toBe("beads");
    expect(caps.deps).toBe(true);
    expect(caps.customStates).toBe(true);
    expect(caps.publicFollowups).toBe(true);
    // prune/render stay unsupported through the documented capability
    // boundary: they are absent, so the CLI names the missing capability.
    expect(caps.prune).toBe(false);
    const asStore: Store = store;
    expect(asStore.prune).toBeUndefined();
    expect(asStore.render).toBeUndefined();
  });

  it("test_create_when_caller_supplies_id_then_beads_stores_it_verbatim", async () => {
    const task = await store.create({
      id: "homemux-h7",
      title: "Wire the homemux pane",
      kind: "ship",
      repo: "firstmate",
      body: "First line\nSecond line",
      priority: 1,
    });
    expect(task.id).toBe("homemux-h7");

    // A tasks-axi id does not match the graph prefix; it must still survive.
    const raw = rawShow(graph, "homemux-h7");
    expect(raw.id).toBe("homemux-h7");
    expect(raw.title).toBe("Wire the homemux pane");
    expect(raw.description).toBe("First line\nSecond line");
    expect(raw.priority).toBe(1);
  });

  it("test_create_mapping_when_kind_and_repo_set_then_namespaced_metadata", () => {
    const meta = metadataOf(graph, "homemux-h7");
    expect(meta["axi.kind"]).toBe("ship");
    expect(meta["axi.repo"]).toBe("firstmate");
    expect(meta["axi.created"]).toBe("2026-07-01");
  });

  it("test_get_when_task_exists_then_round_trips_the_model", async () => {
    const task = await store.get("homemux-h7");
    expect(task).not.toBeNull();
    expect(task?.title).toBe("Wire the homemux pane");
    expect(task?.kind).toBe("ship");
    expect(task?.repo).toBe("firstmate");
    expect(task?.body).toBe("First line\nSecond line");
    expect(task?.priority).toBe(1);
    expect(task?.state).toBe("queued");
    expect(task?.created).toBe("2026-07-01");
  });

  // ---- mapping table: state ------------------------------------------------

  const STATE_TO_BD: Array<[State, string]> = [
    ["queued", "open"],
    ["in_flight", "in_progress"],
    ["done", "closed"],
  ];

  it.each(STATE_TO_BD)(
    "test_transition_when_state_is_%s_then_beads_status_is_%s",
    async (state, bdStatus) => {
      const id = `state-${state}`;
      await store.create({ id, title: `State probe ${state}` });
      const task = await store.transition(id, state);
      expect(task.state).toBe(state);
      expect(rawShow(graph, id).status).toBe(bdStatus);
      // And it normalizes back to the same tasks-axi state.
      expect((await store.get(id))?.state).toBe(state);
    },
  );

  it("test_list_when_blocked_status_stored_then_folds_to_queued", async () => {
    await store.create({ id: "folded-q1", title: "Folded status probe" });
    const set = spawnSync(
      "bd",
      ["-C", graph.repo, "update", "folded-q1", "--status", "blocked"],
      { encoding: "utf8", env: BD_ENV },
    );
    expect(set.status).toBe(0);
    // tasks-axi derives `blocked` from the dependency graph, so a stored
    // Beads `blocked` must present as queued rather than inventing a state.
    expect((await store.get("folded-q1"))?.state).toBe("queued");
  });

  // ---- mapping table: dependencies ----------------------------------------

  const DEP_TO_BD: Array<[DepType, string]> = [
    ["blocked-by", "blocks"],
    ["parent", "parent-child"],
    ["discovered-from", "discovered-from"],
  ];

  it.each(DEP_TO_BD)(
    "test_add_dep_when_type_is_%s_then_beads_edge_type_is_%s",
    async (depType, bdType) => {
      const owner = `dep-owner-${bdType}`;
      const target = `dep-target-${bdType}`;
      await store.create({ id: owner, title: `Owner ${bdType}` });
      await store.create({ id: target, title: `Target ${bdType}` });

      expect(await store.addDep(owner, { type: depType, id: target })).toBe(
        true,
      );
      const raw = rawShow(graph, owner);
      const deps = raw.dependencies as Array<Record<string, unknown>>;
      expect(deps).toHaveLength(1);
      expect(deps[0].dependency_type).toBe(bdType);
      expect(deps[0].id).toBe(target);

      // The typed edge normalizes back to the tasks-axi dep type.
      const task = await store.get(owner);
      expect(task?.deps).toEqual([{ type: depType, id: target }]);
    },
  );

  it("test_add_dep_when_already_present_then_returns_false", async () => {
    await store.create({ id: "idem-a", title: "Idempotent owner" });
    await store.create({ id: "idem-b", title: "Idempotent blocker" });
    expect(
      await store.addDep("idem-a", { type: "blocked-by", id: "idem-b" }),
    ).toBe(true);
    expect(
      await store.addDep("idem-a", { type: "blocked-by", id: "idem-b" }),
    ).toBe(false);
  });

  it("test_add_dep_when_pair_already_has_another_edge_type_then_refuses_naming_it", async () => {
    await store.create({ id: "pair-a", title: "Pair owner" });
    await store.create({ id: "pair-b", title: "Pair other" });
    expect(
      await store.addDep("pair-a", { type: "blocked-by", id: "pair-b" }),
    ).toBe(true);

    // bd stores ONE relationship type per pair, so a second type is refused
    // with the existing edge named rather than surfacing a raw bd error.
    await expect(
      store.addDep("pair-a", { type: "parent", id: "pair-b" }),
    ).rejects.toThrow(
      /already has a blocked-by edge to "pair-b", and bd stores one relationship type per task pair/,
    );
    const owner = await store.get("pair-a");
    expect(owner?.deps).toEqual([{ type: "blocked-by", id: "pair-b" }]);
  });

  it("test_add_dep_when_reason_given_then_reason_survives_round_trip", async () => {
    await store.create({ id: "reason-a", title: "Reason owner" });
    await store.create({ id: "reason-b", title: "Reason blocker" });
    await store.addDep("reason-a", {
      type: "blocked-by",
      id: "reason-b",
      reason: "waits on the upstream rename",
    });
    // Beads' own edge carries no free-text reason, so it is mirrored in
    // namespaced metadata and rejoined on read.
    const task = await store.get("reason-a");
    expect(task?.deps).toEqual([
      {
        type: "blocked-by",
        id: "reason-b",
        reason: "waits on the upstream rename",
      },
    ]);
  });

  it("test_remove_dep_when_edge_present_then_removes_and_reports_true", async () => {
    await store.create({ id: "rm-a", title: "Remove owner" });
    await store.create({ id: "rm-b", title: "Remove blocker" });
    await store.addDep("rm-a", { type: "blocked-by", id: "rm-b" });
    expect(
      await store.removeDep("rm-a", { type: "blocked-by", id: "rm-b" }),
    ).toBe(true);
    expect((await store.get("rm-a"))?.deps).toEqual([]);
    // Read back from bd, not from the adapter that reported the removal.
    expect(rawShow(graph, "rm-a").dependencies ?? []).toEqual([]);
    expect(
      await store.removeDep("rm-a", { type: "blocked-by", id: "rm-b" }),
    ).toBe(false);
  });

  it("test_create_when_blocker_absent_then_refuses_before_writing", async () => {
    await expect(
      store.create({
        id: "dangling-q1",
        title: "Dangling edge",
        deps: [{ type: "blocked-by", id: "no-such-task" }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // The refusal must not leave a half-created task behind.
    expect(await store.get("dangling-q1")).toBeNull();
  });

  // ---- mapping table: holds ------------------------------------------------

  it("test_update_when_hold_set_then_atomic_namespaced_metadata", async () => {
    await store.create({ id: "hold-q1", title: "Hold probe" });
    const result = await store.update("hold-q1", {
      hold: { reason: "waiting on review", kind: "captain", until: "2026-12-01" },
    });
    expect(result.changed).toContain("hold");

    // reason, kind and until land together in ONE Beads key, so a reader never
    // observes a half-written hold.
    expect(metadataOf(graph, "hold-q1")["axi.hold"]).toEqual({
      reason: "waiting on review",
      kind: "captain",
      until: "2026-12-01",
    });
    expect((await store.get("hold-q1"))?.hold).toEqual({
      reason: "waiting on review",
      kind: "captain",
      until: "2026-12-01",
    });
  });

  it("test_update_when_hold_cleared_then_tombstoned_and_reads_as_absent", async () => {
    const result = await store.update("hold-q1", { hold: null });
    expect(result.changed).toContain("hold");
    // bd stores an explicit JSON null rather than dropping the key, because
    // combining --metadata with --unset-metadata is refused and the write must
    // stay a single atomic invocation. A tombstone must read as absent.
    expect(metadataOf(graph, "hold-q1")["axi.hold"]).toBeNull();
    expect((await store.get("hold-q1"))?.hold).toBeUndefined();
  });

  it("test_update_when_patch_is_a_noop_then_changed_is_empty", async () => {
    await store.create({ id: "noop-q1", title: "Noop probe", priority: 2 });
    const result = await store.update("noop-q1", {
      title: "Noop probe",
      priority: 2,
    });
    expect(result.changed).toEqual([]);
  });

  it("test_update_when_archive_body_then_previous_body_is_recoverable", async () => {
    await store.create({ id: "arch-q1", title: "Archive probe", body: "old" });
    const result = await store.update("arch-q1", {
      body: "new",
      archiveBody: true,
    });
    expect(result.changed).toContain("archive");
    expect((await store.get("arch-q1"))?.body).toBe("new");
    // No archive FILE exists beside an authoritative graph; the superseded body
    // is kept in metadata instead.
    expect(metadataOf(graph, "arch-q1")["axi.body_archive"]).toEqual([
      { archived: "2026-07-01", body: "old" },
    ]);
  });

  // ---- mapping table: completion evidence and reopen ----------------------

  it("test_transition_when_done_then_records_evidence_links_and_note", async () => {
    await store.create({ id: "evid-q1", title: "Evidence probe" });
    const task = await store.transition("evid-q1", "done", {
      pr: "https://github.com/o/r/pull/7",
      report: "data/evid-q1/report.md",
      note: "shipped behind a flag",
      date: "2026-07-02",
    });
    expect(task.closed).toBe("2026-07-02");
    expect(task.links).toEqual([
      { kind: "pr", url: "https://github.com/o/r/pull/7" },
      { kind: "report", url: "data/evid-q1/report.md" },
    ]);
    expect(task.body).toContain("shipped behind a flag");
    expect(rawShow(graph, "evid-q1").status).toBe("closed");
  });

  it("test_transition_when_done_repeated_then_backfills_without_restamping", async () => {
    const again = await store.transition("evid-q1", "done", {
      date: "2026-09-09",
    });
    // Idempotent completion: evidence may be backfilled, but the ORIGINAL
    // close date must not move.
    expect(again.closed).toBe("2026-07-02");
  });

  it("test_reopen_when_closed_then_keeps_original_completion_evidence", async () => {
    // bd itself CLEARS closed_at and close_reason on `-s open`, so the stamp
    // only survives because the adapter mirrors it into namespaced metadata.
    const reopened = await store.transition("evid-q1", "queued");
    expect(reopened.state).toBe("queued");
    expect(reopened.closed).toBeUndefined();

    // bd drops the key entirely on reopen rather than nulling it. (`jq .closed_at`
    // cannot tell those apart, which is why this asserts on the parsed object.)
    expect(rawShow(graph, "evid-q1")).not.toHaveProperty("closed_at");
    expect(metadataOf(graph, "evid-q1")["axi.closed"]).toBe("2026-07-02");

    // The original PR/report evidence is still attached after the reopen.
    const task = await store.get("evid-q1");
    expect(task?.links).toEqual([
      { kind: "pr", url: "https://github.com/o/r/pull/7" },
      { kind: "report", url: "data/evid-q1/report.md" },
    ]);
  });

  // ---- list ---------------------------------------------------------------

  it("test_list_when_called_then_reads_the_whole_graph_not_bd_default_page", async () => {
    // bd's own default is --limit 50; a silent truncation would corrupt every
    // derived ready/blocked view.
    const { items, total } = await store.list({});
    expect(total).toBe(items.length);
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((task) => task.id)).toContain("homemux-h7");
  });

  it("test_list_when_filtered_by_repo_then_matches_metadata", async () => {
    const { items } = await store.list({ repo: "firstmate" });
    expect(items.map((task) => task.id)).toEqual(["homemux-h7"]);
  });

  it("test_list_when_limited_then_total_reports_the_unlimited_count", async () => {
    const all = await store.list({});
    const capped = await store.list({ limit: 1 });
    expect(capped.items).toHaveLength(1);
    expect(capped.total).toBe(all.total);
  });

  // ---- remove -------------------------------------------------------------

  it("test_remove_when_active_dependent_exists_then_refuses", async () => {
    await store.create({ id: "keep-blocker", title: "Still blocking" });
    await store.create({ id: "keep-dependent", title: "Blocked work" });
    await store.addDep("keep-dependent", {
      type: "blocked-by",
      id: "keep-blocker",
    });

    // `bd delete --force` would delete this and silently drop the edge, so the
    // guard must live in the adapter.
    await expect(store.remove("keep-blocker")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(await store.get("keep-blocker")).not.toBeNull();
    expect((await store.get("keep-dependent"))?.deps).toEqual([
      { type: "blocked-by", id: "keep-blocker" },
    ]);
  });

  it("test_remove_when_unblocked_then_deletes_from_the_graph", async () => {
    await store.create({ id: "gone-q1", title: "Removable" });
    expect(rawExists(graph, "gone-q1")).toBe(true);
    const removed = await store.remove("gone-q1");
    expect(removed.id).toBe("gone-q1");
    expect(await store.get("gone-q1")).toBeNull();
    // bd exits 0 from a delete that deleted nothing, so the row's absence is
    // read straight from the graph rather than taken from the exit status.
    expect(rawExists(graph, "gone-q1")).toBe(false);
  });

  // ---- public followups ---------------------------------------------------

  it("test_create_when_public_followup_then_typed_payload_round_trips", async () => {
    const task = await store.create({
      id: "public-final-ab",
      title: FOLLOWUP.request.public_safe_summary,
      kind: "public-followup",
      public_followup: FOLLOWUP,
    });
    expect(task.public_followup?.revision).toBe(1);

    // The obligation is stored as one atomic encoded value, not lossy prose.
    expect(typeof metadataOf(graph, "public-final-ab")["axi.public_followup"]).toBe(
      "string",
    );
    const reread = await store.get("public-final-ab");
    expect(reread?.public_followup).toEqual(task.public_followup);
  });

  it("test_transition_when_public_followup_then_refuses_generic_state_change", async () => {
    await expect(
      store.transition("public-final-ab", "done"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("test_update_public_followup_when_revision_is_stale_then_conflict", async () => {
    await expect(
      store.updatePublicFollowup("public-final-ab", {
        expectedRevision: 7,
        expectedPublicFollowup: { ...FOLLOWUP, revision: 7 },
        publicFollowup: { ...FOLLOWUP, revision: 8 },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("test_update_public_followup_when_not_an_obligation_then_validation_error", async () => {
    await expect(
      store.updatePublicFollowup("homemux-h7", {
        expectedRevision: 1,
        expectedPublicFollowup: FOLLOWUP,
        publicFollowup: { ...FOLLOWUP, revision: 2 },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  // ---- negative arms ------------------------------------------------------

  it("test_get_when_id_absent_then_returns_null", async () => {
    expect(await store.get("no-such-task-at-all")).toBeNull();
  });

  it("test_update_when_id_absent_then_not_found_error", async () => {
    await expect(
      store.update("no-such-task-at-all", { title: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("test_remove_when_id_absent_then_not_found_error", async () => {
    await expect(store.remove("no-such-task-at-all")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("test_transition_when_id_absent_then_not_found_error", async () => {
    await expect(
      store.transition("no-such-task-at-all", "done"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("test_add_dep_when_owner_absent_then_not_found_error", async () => {
    await expect(
      store.addDep("no-such-task-at-all", {
        type: "blocked-by",
        id: "homemux-h7",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("test_create_when_id_already_exists_then_conflict", async () => {
    await expect(
      store.create({ id: "homemux-h7", title: "Duplicate" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("test_prefix_fallback_when_bare_id_missing_then_resolves_prefixed_id", async () => {
    const prefixed = new BeadsStore({
      path: graph.beadsDir,
      binary: "bd",
      prefix: "SPIKE",
      now: () => "2026-07-01",
    });
    await prefixed.create({ id: "SPIKE-legacy1", title: "Prefixed task" });
    // Firstmate expects prefix fallback for a legacy markdown id.
    expect((await prefixed.get("legacy1"))?.id).toBe("SPIKE-legacy1");
    // A literal hit still wins, so a bare id is never shadowed.
    expect(await prefixed.get("no-such-task-at-all")).toBeNull();
  });
});

describe("BeadsStore graph resolution", () => {
  it("test_mutation_when_graph_path_unresolvable_then_refuses_without_markdown_fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-axi-nograph-"));
    const store = new BeadsStore({ path: join(dir, "absent", ".beads") });

    let error: unknown;
    try {
      await store.create({ id: "refused-q1", title: "Refused" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AxiError);
    expect((error as AxiError).code).toBe("VALIDATION_ERROR");
    expect((error as Error).message).toContain("Beads graph not found");

    // The refusal must not degrade into writing a markdown backlog anywhere.
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(dir, "backlog.md"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("test_reads_when_graph_path_unresolvable_then_also_refuse", async () => {
    const store = new BeadsStore({ path: "/nonexistent/spike/.beads" });
    await expect(store.get("anything")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(store.list({})).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("test_run_when_bd_binary_missing_then_unsupported_naming_the_binary", async () => {
    const graphDir = mkdtempSync(join(tmpdir(), "tasks-axi-nobin-"));
    const store = new BeadsStore({
      path: graphDir,
      binary: "bd-does-not-exist-anywhere",
    });
    await expect(store.get("anything")).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    rmSync(graphDir, { recursive: true, force: true });
  });
});

/**
 * Concurrent mutation. bd 1.3.0 has no conditional write for a metadata
 * revision, so the adapter's read-validate-write is only safe behind an
 * advisory lock on the graph. These cases drive two mutations at once against
 * ONE graph and assert that exactly one of them lands.
 */
describe.skipIf(!BD_AVAILABLE)("BeadsStore concurrent mutation", () => {
  const graphs: Graph[] = [];

  function freshStore(): { graph: Graph; store: BeadsStore } {
    const graph = makeGraph();
    graphs.push(graph);
    return {
      graph,
      store: new BeadsStore({
        path: graph.beadsDir,
        binary: "bd",
        now: () => "2026-07-01",
      }),
    };
  }

  afterAll(() => {
    for (const graph of graphs) {
      rmSync(graph.repo, { recursive: true, force: true });
    }
  });

  /**
   * Two bd invocations fired back to back are already serialized by bd's own
   * database lock, which is exactly why that lock is NOT a substitute: it
   * covers one invocation, not the read and the write either side of this
   * adapter's validation. The window is therefore opened deliberately, by
   * holding one writer between its read and its write — the think-time a real
   * caller spends in validation (`requireUnblocked` issues a whole `list`) and
   * what a second OS process provides for free.
   */
  function delayBeforeWrite(store: BeadsStore, ms: number): void {
    const target = store as unknown as {
      run: (args: string[]) => Promise<{
        status: number;
        stdout: string;
        stderr: string;
      }>;
    };
    const real = target.run.bind(store);
    vi.spyOn(target, "run").mockImplementation(async (args: string[]) => {
      if (args[0] === "update") {
        await new Promise((done) => setTimeout(done, ms));
      }
      return real(args);
    });
  }

  function storeOn(graph: Graph): BeadsStore {
    return new BeadsStore({
      path: graph.beadsDir,
      binary: "bd",
      now: () => "2026-07-01",
    });
  }

  it("test_update_public_followup_when_a_writer_holds_the_window_then_the_second_is_refused", async () => {
    const { graph, store } = freshStore();
    await store.create({
      id: "race-final-1",
      title: FOLLOWUP.request.public_safe_summary,
      kind: "public-followup",
      public_followup: FOLLOWUP,
    });

    // Two separate stores on ONE graph, as two processes would be.
    const slow = storeOn(graph);
    const quick = storeOn(graph);
    delayBeforeWrite(slow, 1_200);

    // Both writers expect revision 1, so both would pass revision validation
    // on a read taken before the other's write.
    const mutation = {
      expectedRevision: 1,
      expectedPublicFollowup: FOLLOWUP,
      publicFollowup: { ...FOLLOWUP, revision: 2 },
    };
    const first = slow.updatePublicFollowup("race-final-1", mutation);
    await new Promise((done) => setTimeout(done, 150));
    const outcomes = await Promise.allSettled([
      first,
      quick.updatePublicFollowup("race-final-1", mutation),
    ]);
    vi.restoreAllMocks();

    const landed = outcomes.filter((o) => o.status === "fulfilled");
    const refused = outcomes.filter((o) => o.status === "rejected");
    expect(landed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // Fails closed either way: the loser is turned away by the lock itself, or
    // by the revision guard once it can see the winner's write.
    const reason = (refused[0] as PromiseRejectedResult).reason as AxiError;
    expect(reason).toBeInstanceOf(AxiError);
    expect(["CONFLICT", "LOCKED"]).toContain(reason.code);

    // One write landed, so the revision advanced by exactly one — read back
    // from the graph's own stored bytes, not from the adapter's return value.
    expect((await store.get("race-final-1"))?.public_followup?.revision).toBe(2);
    const stored = metadataOf(graph, "race-final-1")["axi.public_followup"];
    expect(typeof stored).toBe("string");
    expect(decodePublicFollowup(stored as string).revision).toBe(2);
  });

  it("test_generic_update_when_a_writer_holds_the_window_then_the_second_is_not_lost", async () => {
    const { graph, store } = freshStore();
    await store.create({ id: "race-meta-1", title: "Shared row" });

    // The same window on the GENERIC path: `update` rewrites the whole owned
    // metadata patch from a value it read earlier, so an interleaved writer's
    // field is silently dropped rather than reported.
    const slow = storeOn(graph);
    const quick = storeOn(graph);
    delayBeforeWrite(slow, 1_200);

    const first = slow.update("race-meta-1", { repo: "alpha" });
    await new Promise((done) => setTimeout(done, 150));
    const outcomes = await Promise.allSettled([
      first,
      quick.update("race-meta-1", { kind: "chore" }),
    ]);
    vi.restoreAllMocks();

    // Neither write is lost: whichever goes second reads the other's committed
    // row, so both fields are in the graph. A refusal is acceptable too — what
    // is not is a success that silently dropped the other field.
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(["LOCKED", "CONFLICT"]).toContain(
          (outcome.reason as AxiError).code,
        );
      }
    }
    const applied = outcomes.filter((o) => o.status === "fulfilled").length;
    const task = await store.get("race-meta-1");
    const survived = [task?.repo === "alpha", task?.kind === "chore"].filter(
      Boolean,
    ).length;
    expect(survived).toBe(applied);
    const raw = metadataOf(graph, "race-meta-1");
    if (task?.repo === "alpha") expect(raw["axi.repo"]).toBe("alpha");
    if (task?.kind === "chore") expect(raw["axi.kind"]).toBe("chore");
  });

  it("test_every_mutation_verb_when_running_then_the_graph_lock_is_held", async () => {
    const { graph, store } = freshStore();
    await store.create({ id: "lock-probe-1", title: "Probe" });
    await store.create({ id: "lock-probe-2", title: "Probe blocker" });

    // One lock, ALL mutations: a mutation serialized against no lock is not
    // serialized at all, so each verb is observed while it is in flight.
    const lockTarget = join(graph.beadsDir, ".tasks-axi");
    const observed = new Map<string, boolean>();
    async function probe(verb: string, call: () => Promise<unknown>) {
      const inFlight = call();
      // Sampled before the call settles; `isLocked` is the same helper the
      // markdown backend's lock is verified with.
      observed.set(verb, isLocked(lockTarget));
      await inFlight;
    }

    await probe("create", () =>
      store.create({ id: "lock-probe-3", title: "Created under lock" }),
    );
    await probe("update", () => store.update("lock-probe-1", { repo: "beta" }));
    await probe("transition", () => store.transition("lock-probe-1", "done"));
    await probe("addDep", () =>
      store.addDep("lock-probe-3", { type: "blocked-by", id: "lock-probe-2" }),
    );
    await probe("removeDep", () =>
      store.removeDep("lock-probe-3", {
        type: "blocked-by",
        id: "lock-probe-2",
      }),
    );
    await probe("remove", () => store.remove("lock-probe-3"));

    expect([...observed.entries()]).toEqual([
      ["create", true],
      ["update", true],
      ["transition", true],
      ["addDep", true],
      ["removeDep", true],
      ["remove", true],
    ]);
    // Released afterwards, so a later caller is not locked out by a leak.
    expect(isLocked(lockTarget)).toBe(false);
  });
});

describe("beads configuration", () => {
  it("test_parse_toml_when_beads_table_then_path_binary_and_prefix_read", () => {
    const parsed = parseConfigToml(
      [
        'backend = "beads"',
        "",
        "[beads]",
        'path = "/repo/.beads"',
        'binary = "/usr/local/bin/bd"',
        'prefix = "aih"',
      ].join("\n"),
    );
    expect(parsed.backend).toBe("beads");
    expect(parsed.beads).toEqual({
      path: "/repo/.beads",
      binary: "/usr/local/bin/bd",
      prefix: "aih",
    });
  });

  it("test_resolve_config_when_env_selects_beads_then_backend_is_beads", () => {
    const resolved = resolveConfig({
      cwd: "/tmp",
      home: "/tmp",
      env: { TASKS_AXI_BACKEND: "beads" },
    });
    expect(resolved.backend).toBe("beads");
    // A graph path is always resolved, defaulting beside the working root.
    expect(resolved.beads.path).toBe("/tmp/.beads");
    expect(resolved.beads.binary).toBe("bd");
  });

  it("test_resolve_context_when_backend_is_beads_then_builds_a_beads_store", () => {
    const ctx = resolveTasksContext({
      cwd: "/tmp",
      home: "/tmp",
      env: { TASKS_AXI_BACKEND: "beads" },
    });
    expect(ctx.store).toBeInstanceOf(BeadsStore);
    expect(ctx.store.capabilities().backend).toBe("beads");
  });

  it("test_resolve_context_when_backend_is_unknown_then_still_unsupported", () => {
    expect(() =>
      resolveTasksContext({
        cwd: "/tmp",
        home: "/tmp",
        env: { TASKS_AXI_BACKEND: "sqlite" },
      }),
    ).toThrowError(/Unsupported backend "sqlite"/);
  });
});

/**
 * `mv` across two graphs. These exercise the command layer, not just the store,
 * because what `--to` DENOTES is a command-layer decision: for a beads home it
 * names another `.beads` graph, and crossing record types is refused by name
 * rather than exported.
 */
describe.skipIf(!BD_AVAILABLE)("BeadsStore cross-graph mv", () => {
  const graphs: Graph[] = [];

  function freshGraph(): Graph {
    const graph = makeGraph();
    graphs.push(graph);
    return graph;
  }

  function contextFor(graph: Graph): TasksContext {
    const config: ResolvedConfig = {
      backend: "beads",
      // Present but deliberately unused: a beads home is addressed by its
      // graph alone, and this file must never be created.
      path: join(graph.repo, "data", "backlog.md"),
      doneKeep: 10,
      beads: { path: graph.beadsDir, binary: "bd" },
    };
    return {
      store: new BeadsStore({
        path: graph.beadsDir,
        binary: "bd",
        now: () => "2026-07-01",
      }),
      config,
    };
  }

  afterAll(() => {
    for (const graph of graphs) {
      rmSync(graph.repo, { recursive: true, force: true });
    }
  });

  it("test_mv_when_connected_set_moves_between_graphs_then_only_destination_holds_them", async () => {
    const source = freshGraph();
    const destination = freshGraph();
    const ctx = contextFor(source);

    await ctx.store.create({ id: "mv-blocker", title: "Lay the cable" });
    await ctx.store.create({
      id: "mv-dependent",
      title: "Light the lamp",
      deps: [{ type: "blocked-by", id: "mv-blocker", reason: "needs power" }],
    });

    const out = await mvCommand(
      ["mv-blocker", "mv-dependent", "--to", destination.repo],
      ctx,
    );
    expect(out).toContain("mv mv-blocker mv-dependent ->");

    // Gone from the source, present in the destination — with the edge and its
    // reason string carried across.
    expect(await ctx.store.get("mv-blocker")).toBeNull();
    expect(await ctx.store.get("mv-dependent")).toBeNull();

    const landed = contextFor(destination).store;
    expect((await landed.get("mv-blocker"))?.title).toBe("Lay the cable");
    const dependent = await landed.get("mv-dependent");
    expect(dependent?.deps).toEqual([
      { type: "blocked-by", id: "mv-blocker", reason: "needs power" },
    ]);
  });

  it("test_mv_when_destination_is_a_markdown_backlog_then_refuses_and_leaves_the_source_intact", async () => {
    const ctx = contextFor(freshGraph());
    await ctx.store.create({ id: "mv-stay", title: "Stay put" });

    const target = join(
      mkdtempSync(join(tmpdir(), "tasks-axi-md-")),
      "backlog.md",
    );
    await expect(mvCommand(["mv-stay", "--to", target], ctx)).rejects.toThrow(
      /cannot move tasks into/,
    );

    // No export happened: the row is still in the graph and no file was written.
    expect((await ctx.store.get("mv-stay"))?.title).toBe("Stay put");
    expect(existsSync(target)).toBe(false);
    expect(existsSync(ctx.config.path)).toBe(false);
  });

  it("test_mv_when_destination_graph_is_absent_then_refuses_without_a_markdown_fallback", async () => {
    const ctx = contextFor(freshGraph());
    await ctx.store.create({ id: "mv-nograph", title: "No graph there" });

    const bare = mkdtempSync(join(tmpdir(), "tasks-axi-bare-"));
    await expect(mvCommand(["mv-nograph", "--to", bare], ctx)).rejects.toThrow(
      /does not name a beads graph/,
    );
    expect((await ctx.store.get("mv-nograph"))?.title).toBe("No graph there");
    expect(readdirSync(bare)).toEqual([]);
  });

  /**
   * A public obligation must exist exactly once, and this transfer is
   * compensating rather than atomic: an interrupted move can leave a row in
   * both graphs. So the set is refused before any write. The control for this
   * case is
   * `test_mv_when_connected_set_moves_between_graphs_then_only_destination_holds_them`
   * above: a set WITHOUT an obligation still transfers.
   */
  it("test_mv_when_the_set_carries_a_public_obligation_then_refuses_before_any_write", async () => {
    const source = freshGraph();
    const destination = freshGraph();
    const ctx = contextFor(source);

    await ctx.store.create({ id: "ob-plain", title: "Ordinary chore" });
    await ctx.store.create({
      id: "ob-promise",
      title: FOLLOWUP.request.public_safe_summary,
      kind: "public-followup",
      public_followup: FOLLOWUP,
    });

    let error: unknown;
    try {
      await mvCommand(
        ["ob-plain", "ob-promise", "--to", destination.repo],
        ctx,
      );
    } catch (caught) {
      error = caught;
    }

    expect((error as AxiError).code).toBe("VALIDATION_ERROR");
    expect((error as Error).message).toContain("ob-promise");
    expect((error as Error).message).toContain("public obligation");

    // Nothing was written on EITHER side — not the obligation, and not the
    // ordinary task that shared the set with it.
    expect(rawExists(destination, "ob-promise")).toBe(false);
    expect(rawExists(destination, "ob-plain")).toBe(false);
    expect((await ctx.store.get("ob-promise"))?.public_followup?.revision).toBe(
      1,
    );
    expect((await ctx.store.get("ob-plain"))?.title).toBe("Ordinary chore");
  });

  /**
   * Failure injection. Two graphs cannot share a transaction, so what the
   * contract actually promises is recoverability: the transfer stops at the
   * first failed source removal, each id ends up in exactly one graph wherever
   * the adapter can still reach it, and the error says which. The injection
   * replaces ONE `bd delete` for ONE id and leaves every other invocation
   * running against the real graph.
   */
  function failDeleteOf(store: BeadsStore, id: string): void {
    const target = store as unknown as {
      run: (args: string[]) => Promise<{
        status: number;
        stdout: string;
        stderr: string;
      }>;
    };
    const real = target.run.bind(store);
    vi.spyOn(target, "run").mockImplementation(async (args: string[]) => {
      if (args[0] === "delete" && args[1] === id) {
        return { status: 1, stdout: "", stderr: "dolt: table is locked" };
      }
      return real(args);
    });
  }

  it("test_transfer_many_when_a_source_delete_fails_then_stops_and_names_where_each_id_lives", async () => {
    const source = freshGraph();
    const destination = freshGraph();
    const ctx = contextFor(source);
    const landed = contextFor(destination).store;

    await ctx.store.create({ id: "fi-blocker", title: "Lay the cable" });
    await ctx.store.create({
      id: "fi-dependent",
      title: "Light the lamp",
      deps: [{ type: "blocked-by", id: "fi-blocker", reason: "needs power" }],
    });

    // Removal order is dependents before blockers, so failing the BLOCKER's
    // delete leaves the dependent already gone from the source.
    failDeleteOf(ctx.store as BeadsStore, "fi-blocker");

    let error: unknown;
    try {
      await mvCommand(
        ["fi-blocker", "fi-dependent", "--to", destination.repo],
        ctx,
      );
    } catch (caught) {
      error = caught;
    }
    vi.restoreAllMocks();

    expect(error).toBeInstanceOf(AxiError);
    expect((error as AxiError).code).toBe("CONFLICT");
    expect((error as Error).message).toContain("split across two collections");
    const suggestions = (error as AxiError).suggestions.join("\n");
    expect(suggestions).toContain("fi-dependent");
    expect(suggestions).toContain("fi-blocker");
    expect(suggestions).toContain("dolt: table is locked");

    // The id whose removal failed kept its source row. Its destination copy is
    // KEPT too, not rolled back: `fi-dependent` has already moved, so deleting
    // its blocker in the destination would strip that dependent's edge for
    // good. The error says so rather than claiming a clean undo.
    expect((await ctx.store.get("fi-blocker"))?.title).toBe("Lay the cable");
    expect((await landed.get("fi-blocker"))?.title).toBe("Lay the cable");
    expect(suggestions).toContain("kept in");
    // The id already removed from the source is in exactly ONE graph.
    expect(await ctx.store.get("fi-dependent")).toBeNull();
    expect((await landed.get("fi-dependent"))?.title).toBe("Light the lamp");
  });

  it("test_transfer_many_when_rollback_would_strip_a_moved_dependents_edge_then_keeps_the_blocker_and_names_it", async () => {
    const source = freshGraph();
    const destination = freshGraph();
    const ctx = contextFor(source);
    const landed = contextFor(destination).store;

    await ctx.store.create({ id: "fe-blocker", title: "Lay the cable" });
    await ctx.store.create({
      id: "fe-dependent",
      title: "Light the lamp",
      deps: [{ type: "blocked-by", id: "fe-blocker", reason: "needs power" }],
    });

    // Dependents are removed first, so failing the blocker's delete leaves the
    // dependent in the destination and its blocker staged there beside it.
    failDeleteOf(ctx.store as BeadsStore, "fe-blocker");

    let error: unknown;
    try {
      await mvCommand(
        ["fe-blocker", "fe-dependent", "--to", destination.repo],
        ctx,
      );
    } catch (caught) {
      error = caught;
    }
    vi.restoreAllMocks();

    expect((error as AxiError).code).toBe("CONFLICT");

    // What recoverability means here: the surviving dependent keeps BOTH its
    // edge and the reason on it. `bd delete --force` drops a dependent's edge
    // silently, and no retry of the failed blocker could restore it, so the
    // rollback must not have deleted the blocker in the destination.
    expect((await landed.get("fe-dependent"))?.deps).toEqual([
      { type: "blocked-by", id: "fe-blocker", reason: "needs power" },
    ]);
    // Proved against bd itself, not against the adapter that kept the row.
    expect(rawExists(destination, "fe-blocker")).toBe(true);
    expect((await ctx.store.get("fe-blocker"))?.title).toBe("Lay the cable");

    const suggestions = (error as AxiError).suggestions.join("\n");
    expect(suggestions).toContain("kept in");
    expect(suggestions).toContain("fe-blocker");
  });

  it("test_transfer_many_when_the_first_source_delete_fails_then_nothing_leaves_the_source", async () => {
    const source = freshGraph();
    const destination = freshGraph();
    const ctx = contextFor(source);
    const landed = contextFor(destination).store;

    await ctx.store.create({ id: "fi-solo", title: "Stay home" });
    failDeleteOf(ctx.store as BeadsStore, "fi-solo");

    let error: unknown;
    try {
      await mvCommand(["fi-solo", "--to", destination.repo], ctx);
    } catch (caught) {
      error = caught;
    }
    vi.restoreAllMocks();

    expect((error as AxiError).code).toBe("CONFLICT");
    expect((error as Error).message).toContain("no task left it");
    expect((await ctx.store.get("fi-solo"))?.title).toBe("Stay home");
    expect(await landed.get("fi-solo")).toBeNull();
  });

  it("test_transfer_many_when_rollback_delete_fails_then_names_the_residue", async () => {
    const source = freshGraph();
    const destination = freshGraph();
    const ctx = contextFor(source);
    const landed = contextFor(destination).store;

    await ctx.store.create({ id: "fi-both", title: "In both graphs" });
    // Called directly rather than through `mv`, because the residue is created
    // by the DESTINATION store refusing the rollback and `mv` builds that
    // instance internally.
    failDeleteOf(landed as BeadsStore, "fi-both");
    failDeleteOf(ctx.store as BeadsStore, "fi-both");

    let error: unknown;
    try {
      await (ctx.store as BeadsStore).transferMany(["fi-both"], landed);
    } catch (caught) {
      error = caught;
    }
    vi.restoreAllMocks();

    expect((error as AxiError).code).toBe("CONFLICT");
    const suggestions = (error as AxiError).suggestions.join("\n");
    expect(suggestions).toContain("In BOTH collections");
    expect(suggestions).toContain("fi-both");
    // Reported honestly: the row really is in both graphs now.
    expect((await ctx.store.get("fi-both"))?.title).toBe("In both graphs");
    expect((await landed.get("fi-both"))?.title).toBe("In both graphs");
  });

  it("test_transfer_many_when_destination_is_not_a_graph_then_names_the_backend", async () => {
    const store = contextFor(freshGraph()).store as BeadsStore;
    await store.create({ id: "mv-direct", title: "Direct call" });

    const notAGraph = new MarkdownStore({
      path: join(mkdtempSync(join(tmpdir(), "tasks-axi-md-")), "backlog.md"),
    });
    await expect(store.transferMany(["mv-direct"], notAGraph)).rejects.toThrow(
      /can only transfer tasks into another beads graph, not "markdown"/,
    );
    expect((await store.get("mv-direct"))?.title).toBe("Direct call");
  });
});
