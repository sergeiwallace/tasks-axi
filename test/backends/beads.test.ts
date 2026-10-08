import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import { AxiError } from "../../src/errors.js";
import type { DepType, State } from "../../src/model.js";
import type { Store } from "../../src/store.js";
import { parseConfigToml, resolveConfig } from "../../src/config.js";
import { resolveTasksContext } from "../../src/context.js";

/**
 * Contract tests for the Beads-backed store (AIH-nta1e).
 *
 * These run against a DISPOSABLE Beads graph created in a temp directory, and
 * freeze the mapping table from
 * docs/research/firstmate-runtime-backends-and-tasks-axi-adapter.md as
 * executable assertions. Every mapping assertion reads the stored Beads record
 * back through `bd` itself, so a mapping claim is checked against the real
 * store rather than against this adapter's own normalizer.
 *
 * The graph is created with the store-only `bd init` invocation the fleet
 * wrapper uses (`--skip-agents --skip-hooks --non-interactive`), which keeps bd
 * from injecting per-repo context files or seizing core.hooksPath. The graph is
 * embedded and local: no Dolt server is contacted.
 */

// Each case drives several real `bd` invocations against an embedded Dolt
// store; the 5s default is a harness limit, not a contract.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

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

const BD_AVAILABLE = hasBd();

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
    const removed = await store.remove("gone-q1");
    expect(removed.id).toBe("gone-q1");
    expect(await store.get("gone-q1")).toBeNull();
  });

  // ---- public followups ---------------------------------------------------

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
