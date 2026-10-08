# Beads tasks-axi backend — implementation spike findings

**Task:** AIH-nta1e (child of AIH-62xkr). Implementation half of the spike the
research doc `docs/research/firstmate-runtime-backends-and-tasks-axi-adapter.md`
recommends: build the store/config seam, freeze the mappings as contract tests,
run Firstmate's Beads fixtures without their markdown-only skips, and answer the
13 open questions with evidence.

**Measured against:**

| Component | Version / commit |
|---|---|
| tasks-axi | `0.2.6`, base commit `9401ff8` (branch `spike/beads-backend`) |
| `bd` | `1.3.0 (f45b249ce: HEAD@f45b249ce6b4)` |
| Firstmate fork | `/data/projects/firstmate` (read-only; probed from a temp copy) |
| node / pnpm | `v24.21.0` / `12.6.0` (repo pins `packageManager: pnpm@11.1.1`) |
| Host | `AI_HOST=sem-kg-ec2` |

**Labels used below:** *Observed* = measured on this host; *Inference* =
reasoned from observations, not directly measured; *Unknown* = not established
by this spike.

---

## 1. Gate results

| Gate | Base `9401ff8` (control) | This branch |
|---|---|---|
| `npm run build` | 0 | 0 |
| `npm test` | 444 passed, 1 skipped (22 files) | 489 passed, 1 skipped (23 files) |
| `npm run lint` | 0 | 0 |

The 1 skip is pre-existing, in `test/backends/markdown-grammar.test.ts`, and is
unchanged by this branch. **There were no pre-existing failures**: the base
commit was green on all three gates before any edit, measured in this same
worktree. The 45 new tests are the whole delta (444 + 45 = 489).

Two deviations from the brief's stated commands, both measured:

- **`npm ci` refuses**: there is no `package-lock.json` in this repo
  (`.gitignore` does not ignore one; none is committed). `package.json` declares
  `packageManager: pnpm@11.1.1` with a committed `pnpm-lock.yaml`, so
  dependencies were installed with `pnpm install --frozen-lockfile` (exit 0),
  which honours the committed lockfile and leaves no stray lockfile behind.
- **`bd_repo_setup.py` was not used to create the disposable graph.** It is
  manifest-driven (`config/bd_fleet_prefixes.yaml`), acts only on repos named in
  that manifest under a projects root, and — decisively — *"promotes the fresh
  embedded database to the machine-local shared Dolt server"*
  (`bd_repo_setup.py` docstring, and `promote_to_shared_server` at line 444),
  which the brief forbids touching. The graph is therefore created with that
  wrapper's own canonical store-only invocation, `INIT_ARGS`
  (`bd_repo_setup.py:246-265`): `bd init --prefix SPIKE --skip-agents
  --skip-hooks --non-interactive`. That preserves the invariant the "never run a
  bare `bd init`" rule exists to protect (no context-file injection, no
  `core.hooksPath` seizure) while keeping the graph embedded, disposable and
  entirely under a temp directory. No Dolt server was contacted and no existing
  `.beads/` store was touched.

---

## 2. What was built

| Artifact | Purpose |
|---|---|
| `src/backends/beads.ts` | `BeadsStore implements Store` over the `bd` CLI |
| `src/config.ts` | `[beads]` table (`path`, `binary`, `prefix`) → `ResolvedConfig.beads` |
| `src/context.ts:25-48` | `backend = "beads"` builds a `BeadsStore` |
| `test/backends/beads.test.ts` | 45 contract tests against a disposable graph |

All ten required `Store` members are implemented (`store.ts:57-78`):
`capabilities`, `create`, `get`, `update`, `remove`, `list`, `transition`,
`addDep`, `removeDep`, `updatePublicFollowup`. The two optional members
(`store.ts:81,83`) are **absent by design**, so the CLI reports the missing
capability by name rather than this adapter inventing an archive file beside an
authoritative graph.

Advertised capabilities: `deps: true`, `customStates: true`,
`publicFollowups: true`, `prune: false`, `comments: false`,
`fullTextSearch: false`, `realtimeSync: false`, `serverMintsIds: false`.
`comments` is `false` despite Beads having first-class comments because the
`Store` seam exposes no comment verb — advertising it would promise something
the CLI cannot reach.

---

## 3. Measured `bd` 1.3.0 JSON shapes

These are the shapes the normalizer defends against. Each was measured against
the disposable graph.

**`bd show <id> --json` returns a JSON ARRAY**, even for a single id, while
**`bd create --json` returns an OBJECT**. Observed.

```json
[ { "id": "SPIKE-alpha", "title": "Probe alpha task",
    "description": "Body line one\nBody line two",
    "status": "open", "priority": 1, "issue_type": "task",
    "owner": "spike@local", "created_at": "2026-10-08T05:46:40Z",
    "created_by": "Spike", "updated_at": "2026-10-08T05:46:40Z",
    "metadata": { ... }, "labels": ["id:SPIKE-alpha"],
    "dependent_count": 0, "dependency_count": 0, "comment_count": 0,
    "revision": "-5246042376004217957" } ]
```

**The shape is sparse: a field materializes only once set.** `started_at`,
`closed_at` and `close_reason` are absent until the lifecycle sets them, and
`description` is absent (not empty) when there is no body. `bd list --help`
states this directly for `--brief`: *"An omitted field is indistinguishable from
an empty one in `--json`; fetch a whole issue with `bd show`."* Observed.

> **Instrument caveat worth recording:** `jq '.closed_at'` prints `null` both
> for a stored null and for an **absent key**, so a `jq`-based probe cannot tell
> them apart. An earlier reading in this spike recorded `closed_at: null` after
> a reopen; asserting on the parsed object showed the key is in fact **absent**.
> `test_reopen_...` asserts `not.toHaveProperty("closed_at")` for that reason.

**`dependencies` is absent when empty, and carries a DIFFERENT shape per
command.** This is the single most important drift finding. Observed:

| Command | Edge shape |
|---|---|
| `bd show --json` | `{ "id": "<blocker>", "title": ..., "status": ..., "dependency_type": "blocks" }` — the full nested blocker issue |
| `bd list --json` | `{ "issue_id": "<owner>", "depends_on_id": "<blocker>", "type": "blocks", "created_at": ..., "metadata": "{}" }` — an edge record |

Note also that the edge's own `metadata` in the `list` shape is a **string**
(`"{}"`), not an object. `parseDependencies()` accepts both shapes
(`dependency_type ?? type`, `depends_on_id ?? id`) so no caller needs to know
which command produced the record.

`revision` is a **signed 64-bit integer rendered as a string**
(`"-5246042376004217957"`), not a monotonic counter. It changes on a field
update but **did not change when a dependency edge was added** — so it is a row
revision, not a graph revision. Observed.

Timestamp precision differs between commands: `bd create --json` returned
`2026-10-08T05:46:39.976495645Z` (nanoseconds) where `bd show --json` returned
`2026-10-08T05:46:40Z` (whole seconds) for the same issue. The adapter stores
tasks-axi's own `YYYY-MM-DD` stamps in metadata rather than depending on either.
Observed.

`bd` writes advisory warnings to **stderr** (e.g. `warning: beads.role not
configured (GH#2950)`) while JSON goes to stdout, so stdout-only parsing is
unaffected. Observed.

**Not-found** exits 1 and emits BOTH a plain-text stderr line and a JSON error
object on stdout: `{"error": "no issues found matching the provided IDs",
"hint": "...", "schema_version": 1}`. Observed.

### Three behaviours that are traps

1. **Reopen destroys bd's own completion evidence.** `bd update <id> -s open` on
   a closed issue clears **both** `closed_at` and `close_reason`. Observed:
   before reopen `{"status":"closed","closed_at":"2026-10-08T05:47:31Z",
   "close_reason":"spike probe close"}`; after, both gone. The research doc
   requires *"reopen reverses `closed` without losing original completion
   evidence"*, which is therefore **impossible using bd's native fields**. The
   adapter mirrors the stamp into `axi.closed`, and `transition()` carries it
   through explicitly. Frozen by
   `test_reopen_when_closed_then_keeps_original_completion_evidence`.

2. **`bd delete --force` deletes an issue that still has dependents**, silently
   removing their edges — despite `bd delete --help` claiming *"Default: Fails if
   any issue has dependents not in deletion set"*. Observed: deleting
   `SPIKE-blocker` (dependent_count 1) succeeded with
   `"✓ Deleted SPIKE-blocker / Removed 1 dependency link(s)"`, and the dependent
   `SPIKE-alpha` dropped to `dependency_count: 0`. The markdown backend refuses
   this (`markdown.ts:407-417`), so **the active-dependents guard lives in the
   adapter**, before the delete. Frozen by
   `test_remove_when_active_dependent_exists_then_refuses`.

3. **`bd delete` WITHOUT `--force` prints a preview and exits 0** having deleted
   nothing. A caller branching on exit status would read a successful removal
   that never happened. `--force` is therefore mandatory on the delete path.
   Observed.

### Metadata semantics (load-bearing for holds and obligations)

- `--metadata` accepts **arbitrary nested JSON** (objects and arrays) and
  **merges** into existing metadata rather than replacing it. Observed: keys set
  at create survived a later `--metadata` call that did not mention them.
- Dotted keys such as `axi.hold` are **literal flat keys**, not nested paths.
- `--set-metadata k=v` always stores a **string**: `axi.probe={"a":1}` read back
  as `"{\"a\":1}"`. The adapter therefore uses `--metadata` for typed values and
  never `--set-metadata`.
- `--unset-metadata <key>` removes a key, **but**: `bd create` has no
  `--unset-metadata` at all, and `bd update` **refuses to combine** `--metadata`
  with `--unset-metadata` (`Error: cannot combine --metadata with
  --set-metadata or --unset-metadata`). Clearing one key while setting another
  would need two invocations, i.e. a window where a hold or a completion is
  half-written.
- A JSON `null` value is **stored as null** (key present, value null) rather than
  removing the key. Observed.

Consequence, and the design the code adopts: every metadata write sends **all**
owned keys in **one** `--metadata` call, using explicit `null` as a tombstone.
That keeps each mutation a single atomic `bd` invocation. The cost is that a
cleared key lingers holding `null`; readers treat null as absent. Frozen by
`test_update_when_hold_cleared_then_tombstoned_and_reads_as_absent`.

### Caller-supplied ids

`bd create --id <id>` stores a caller-supplied id **verbatim**, but refuses one
whose prefix differs from the database prefix: `Error: prefix mismatch: database
uses 'SPIKE-' but ID 'aih-foreign1' doesn't match (use --force to override)`
(exit 1). With `--force` it succeeds. Observed. tasks-axi ids are arbitrary
slugs (`model.ts:61` gives `"homemux-h7"` as the canonical example), so the
adapter passes `--force` on every create: the join key must survive verbatim.
Frozen by `test_create_when_caller_supplies_id_then_beads_stores_it_verbatim`.

---

## 4. The 13 open questions

### OQ-1 — upstream backend, maintained fork, or loaded plugin?

**Observed (the ABI half); DECISION FOR SERGEI (the placement half).**

There is **no external backend loading path of any kind**. A search of the whole
source tree for `await import(`, `require(`, `createRequire`, `plugin`,
`loadBackend`, `registerBackend`, `BACKENDS` returns exactly one hit:
`bin/tasks-axi.ts:6`, the CLI's own lazy self-load of `src/cli.js` (a
version fast-path optimization). There is no backend registry and no map;
selection is a hardcoded identity comparison in `src/context.ts:25`. Before this
branch that line read `if (config.backend !== "markdown") throw ... "P1 ships
the markdown backend only"`, and the base build still refuses `beads` —
verified: `TASKS_AXI_BACKEND=beads tasks-axi list` against the base-commit build
returns `code: UNSUPPORTED`.

So a Beads adapter **must be in-tree**. "Separately loaded plugin" is not an
option without first designing and landing a plugin ABI upstream. That narrows
the real choice to two:

| Option | Pros | Cons |
|---|---|---|
| **(a) Maintained fork** | Lands immediately; no upstream negotiation; free to carry the fleet's `axi.*` metadata conventions; the fork is already the plan of record in AIH-62xkr's approved D-1 | Permanent rebase burden against a pre-1.0 upstream that is actively changing (`0.2.6` released as the base commit); the `mv` defect in OQ-8 needs a command-layer change, widening the fork's surface beyond one new file |
| **(b) Upstream contribution** | No divergence; `store.ts`'s seam comment explicitly anticipates additional backends (*"swapping in sqlite/remote backends (P2/P3) never touches arg parsing or rendering"*), so a new backend is a shape upstream invites | Upstream must accept a backend whose value depends on Beads specifically; the useful version is gated on a release cycle we do not control; the `mv` fix (OQ-8) is a semantic change upstream may reasonably refuse |

**What this spike's code assumes:** option (a)-shaped — the adapter is a new
in-tree file plus a ~30-line config addition and a 2-line change to the backend
gate in `context.ts`. That deliberately keeps the diff small enough to be
offered upstream unchanged if Sergei prefers (b); nothing in
`src/backends/beads.ts` depends on fleet-specific paths. **Not decided here.**

### OQ-2 — one aggregate graph, or per-repo routing?

**Observed (the mechanism); DECISION FOR SERGEI (the policy).**

A single `[beads].path` addresses exactly one `.beads` directory, so as
implemented one tasks-axi home maps to **one** graph. The relevant mechanism I
measured: `.beads/metadata.json` is **tracked** and names the database
(`{"dolt_database": "DUE", "dolt_mode": "embedded", ...}`), so the graph identity
travels with the repo rather than with a path.

| Option | Pros | Cons |
|---|---|---|
| **(a) One aggregate graph per home** | Matches the single `[beads].path` shape with no further design; cross-repo `blocked-by` edges are expressible, which per-repo stores cannot do; one `list` serves the whole dashboard | Diverges from the fleet's current per-repo stores, where "the owning repo" owns its issues; needs a migration; `Task.repo` becomes the only repo signal (already carried in `axi.repo`) |
| **(b) Per-repo routing** | Preserves the fleet's existing one-store-per-repo model and the prefix bijection; each repo's issues stay with its code | A single `[beads].path` cannot express it — needs a routing table keyed on `Task.repo`, and `bd` has no cross-database query, so `list` becomes a fan-out whose cost grows with repo count; a cross-repo dependency edge has no representation at all |

**What this spike's code assumes:** (a), one graph per configured path, because
it is what the configuration shape in the research doc already describes and it
needs no new design. `Task.repo` round-trips through `axi.repo` either way, so
(b) remains reachable without changing the mapping. **Not decided here.**

### OQ-3 — which Beads field owns the curated body, and how are links represented?

**Observed.** The body maps to Beads `description`. `bd update --body-file <path>`
replaces it preserving the bytes exactly, including the trailing newline
(`"Replaced body\nsecond line\n"`), and `--description` passes a value through
argv unchanged including embedded newlines. `--allow-empty-description` is
required to write an empty body.

Links are **not** parsed out of prose. The adapter mirrors the markdown backend
exactly: a typed link is folded into the title text and `Task.links` is derived
with the shared `deriveLinks()` from `markdown-grammar.ts`. That keeps CLI
rendering and TOON field names identical across backends, which is what the
Firstmate conformance requirement needs, and avoids a second, divergent link
representation. `notes` is deliberately unused: `description` is the single prose
field, so there is no ambiguity about which one is curated.

Everything that is not a native Beads column lives in flat namespaced metadata:

| tasks-axi | Beads |
|---|---|
| `title` | `title` |
| `body` | `description` |
| `state` | `status` (see OQ-5 table) |
| `priority` (0-4) | `priority` (0-4), direct |
| `kind` | `axi.kind` metadata |
| `repo` | `axi.repo` metadata |
| `hold` | `axi.hold` metadata (one object) |
| `created` / `closed` | `axi.created` / `axi.closed` metadata |
| `deps` | native typed edges + `axi.dep_reasons` for the free text |
| `public_followup` | `axi.public_followup` (base64url canonical JSON) |
| `meta` | `axi.meta` metadata |
| archived body | `axi.body_archive` metadata (append-only list) |
| `links` | derived from the title, as in markdown |

`kind` is metadata rather than `issue_type` deliberately: `bd`'s `--type` is a
closed enum (`bug|feature|task|epic|chore|decision|spike|story|milestone`;
custom types need a `types.custom` config) whereas tasks-axi `kind` is free-form
(`ship`, `scout`, `secondmate`, `public-followup`). `issue_type` is left at
`task`.

### OQ-4 — how are holds encoded atomically and queried?

**Observed (encoding); partly Unknown (query efficiency).**

A hold's three fields land in a **single** Beads metadata key as one nested
object, so one `bd update` writes the whole hold and no reader can observe it
half-applied — this is exactly why the tombstone design in §3 matters.
Measured round-trip: `axi.hold = {"reason":"waiting on review",
"kind":"captain","until":"2026-12-01"}`. All five `HoldKind` values
(`captain`, `external`, `load`, `parked`, `future`) are carried verbatim and
validated against `HOLD_KINDS` before the write, so the captain/external/load/
parked/future distinction is preserved exactly.

Date expiry is **not** evaluated by Beads. `until` is stored as a plain
`YYYY-MM-DD` string and tasks-axi's own CLI derives `held` from it, which is the
correct division: `derive.ts` already owns that projection for every backend.

**Query efficiency is Unknown.** `bd list` cannot filter on metadata (its
filters cover status, labels, type, assignee, priority — not arbitrary metadata
keys), so held work is found by listing and filtering in the CLI layer, same as
`repo`/`kind`. That is O(graph) per query. Whether it is *fast enough* at fleet
scale was not measured: the disposable graph held ~20 issues. A label mirror
(`bd update --add-label held`) would make it an indexed query, and is the
obvious optimization if a measurement later shows it is needed — not added here,
as the spec does not ask for it.

### OQ-5 — exact dependency-type mapping; expose nonblocking relations?

**Observed.** `bd dep add --type` accepts: `blocks`, `tracks`, `related`,
`parent-child`, `discovered-from`, `until`, `caused-by`, `validates`,
`relates-to`, `supersedes`; `blocked-by` and `depends-on` are documented aliases
for `blocks`. With no `-t` the edge defaults to `blocks`.

| tasks-axi `DepType` | Beads `--type` |
|---|---|
| `blocked-by` | `blocks` |
| `parent` | `parent-child` |
| `discovered-from` | `discovered-from` |

Each direction is frozen by a table-driven test that reads the stored
`dependency_type` back through `bd` itself.

**Nonblocking Beads relations are deliberately NOT surfaced.** tasks-axi derives
`blocked`/`ready` from `Task.deps` alone, so putting a `tracks` or `relates-to`
edge there would make unrelated work read as blocked — a correctness bug, not a
cosmetic one. `BD_TO_DEP` maps only the three types above and silently ignores
the rest, which also means a human adding a `relates-to` edge in `bd` cannot
corrupt a tasks-axi readiness view.

One representational gap: a Beads edge carries no free-text reason, and
`bd dep add` has no reason flag, so tasks-axi's `blocked-by: <id> - <reason>`
text is mirrored in `axi.dep_reasons` keyed `"<type>:<id>"` and rejoined on read.
The edge itself stays native. Frozen by
`test_add_dep_when_reason_given_then_reason_survives_round_trip`.

### OQ-6 — caller-supplied ids, configured prefixes, legacy markdown ids

**Observed.** See §3 "Caller-supplied ids" for the prefix-mismatch refusal and
the `--force` override. The adapter passes `--force` so an arbitrary tasks-axi
slug survives verbatim.

Prefix fallback is implemented as the research doc describes: `resolve(id)` tries
the literal id first and, only on a miss and only when `[beads].prefix` is set,
retries `<prefix>-<id>`. A literal hit always wins, so a graph with a prefix can
still hold a legacy markdown id verbatim without being shadowed. Frozen by
`test_prefix_fallback_when_bare_id_missing_then_resolves_prefixed_id`.

The Firstmate fork's own migration-marker tests exercised this and pass — see
§5, specifically *"verify resolves a captain hold whose id is the legacy id under
the configured prefix"* and *"the marker-noted row wins over an unrelated row
holding the prefix namesake"*.

**Residual collision risk (Inference):** if a graph contains both `legacy1` and
`SPIKE-legacy1`, the fallback is unreachable for the latter via the bare id —
correct, but it means a bare id is never ambiguous *only because* the literal
lookup wins. Two distinct tasks whose ids differ solely by the configured prefix
are therefore addressable but easy to confuse for a human. Not a defect in the
mapping; worth a naming convention.

### OQ-7 — can `done` atomically close, attach evidence, stay idempotent, and backfill without changing the original close date?

**Observed. Yes, with the caveat that it required working around bd.**

A completion is one `bd update` carrying status, title (with the PR/report links
folded in), description (with the note appended) and the whole metadata patch —
so it is a single atomic invocation. `--force` is passed because bd otherwise
refuses to close an issue with open children or a live blocker (`bd update
--help`), whereas tasks-axi's `done` is a plain state move the markdown backend
never refuses.

Idempotency and backfill both work, and **the original close date does not
move**: `transition(..., "done")` keeps the existing stamp
(`task.closed = closedEvidence ?? date`), so a repeat completion with a later
date still reports the first one. Frozen by
`test_transition_when_done_repeated_then_backfills_without_restamping`
(closed `2026-07-02`, re-completed with `2026-09-09`, still reports
`2026-07-02`).

The hard part is the reopen, and it is the one place bd actively fights the
requirement — see §3 trap 1. Because `-s open` clears `closed_at` and
`close_reason`, the durable stamp lives in `axi.closed` and is explicitly
carried through a reopen. **This was a real bug in the first draft of this
adapter**: `transition()` away from `done` tombstoned `axi.closed`, destroying
the evidence it exists to preserve, and the contract test is what caught it.

### OQ-8 — what should `mv <id>... --to <destination>` mean across Beads graphs?

**Observed — and this is the one place the ask and the measured code genuinely
disagree. It cannot be fixed from inside the `Store` seam.**

`mv` is file-oriented at the **command** layer, not merely the store layer.
`src/commands/state.ts:717` unconditionally constructs the destination as a
markdown file — `const target = new MarkdownStore({ path: targetPath })` —
regardless of the active backend. Then at lines 727-737:

- if the source store **is** a `MarkdownStore`, it uses the atomic
  `moveManyTo`;
- else if exactly **one** id, it does `target.create(...)` followed by
  `store.remove(...)` — i.e. it **exports the task out of Beads into a markdown
  file**, non-atomically;
- else it throws `UNSUPPORTED`: *"Moving multiple tasks at once requires the
  markdown backend"*.

Both non-markdown branches are wrong for this ask:

1. The single-id branch **violates the founding ask directly** — "Beads stays the
   SOLE task system of record... no markdown fallback" — by writing a markdown
   backlog and deleting the Beads row.
2. The multi-id branch **breaks Firstmate's secondmate handoff**, which requires
   atomic multi-ID `mv`: `bin/fm-tasks-axi-lib.sh:15` states *"validated
   secondmate handoffs always use `tasks-axi mv`"*, and the compatibility probe
   `fm_tasks_axi_mv_has_multi_id` (line 103) exists precisely to assert that
   capability.

So a Beads-backed home as the code stands today would either silently export
tasks to markdown or refuse handoffs. **Reported, not resolved** — the fix is a
command-layer change (teach `mv` to construct a destination store from config
rather than hardcoding `MarkdownStore`, and add a cross-store atomic move), which
is a design decision about tasks-axi's semantics and outside this spike's scope.
It is also the single largest argument for the fork-surface Con in OQ-1(a).

**Unknown:** what `--to` should even denote for a graph store — another
`.beads` path, a database name, or a `repo` reassignment inside one graph. That
depends on OQ-2's resolution.

### OQ-9 — will public-followup obligations be supported in Beads?

**Observed. Yes, fully.**

The whole typed obligation is stored as one base64url-encoded canonical JSON
string in `axi.public_followup`, reusing the existing
`encodePublicFollowup`/`decodePublicFollowup` and the full validator in
`src/public-followup.ts` unchanged. This matters for two reasons:

- the encoded payload is **one metadata value**, so a revision bump and an
  atomic completion travel in a **single** `bd update` — the obligation is never
  observable half-applied, which is the property the state machine requires;
- no Beads-specific re-modelling of the 13-state delivery machine is needed, so
  there is no second schema to keep in sync.

`capabilities().publicFollowups` is `true`. `updatePublicFollowup` enforces the
same guards as the markdown backend: stale-revision `CONFLICT` (checked with
`canonicalEqual` against the full expected payload, not just the revision
number), refusal on an already-complete obligation, the `requireUnblocked`
blocker recheck, `assertPublicFollowupMutation` for append-only relation
evidence, and the completion/terminal symmetry checks. Generic `update`,
`transition` and `remove` all refuse to touch an obligation, as in markdown.
Frozen by four tests including a full encode/store/decode round-trip.

So Relay/public-reply workflows are **not** blocked by the backend choice.

### OQ-10 — supported `bd` versions and defence against drift

**Observed (shapes and defences); Unknown (version range).**

The shapes are in §3. The defences in the code:

- **Dual-shape dependency parsing** (the two measured `dependencies` layouts).
- **Sparse-field tolerance**: every field is type-checked before use
  (`typeof x === "string"`), so an absent key, a null and a wrong type all read
  as absent rather than throwing.
- **Array-or-object tolerance** on `show`, which returns an array.
- **Explicit `--limit 0`** on every list. bd's default is `--limit 50`, so a
  naive list would **silently truncate** the backlog and corrupt every derived
  ready/blocked/held view. Frozen by
  `test_list_when_called_then_reads_the_whole_graph_not_bd_default_page`.
- **Oversized payloads**: `maxBuffer` is set to 64 MiB explicitly, because the
  `show` dependency shape nests a full issue record per edge.
- **Timeouts**: a 120 s bound per invocation, surfaced as a structured error
  naming the timeout rather than a hang.
- **Non-blocking I/O**: the store spawns asynchronously. The first draft used
  `spawnSync`, which blocked the Node event loop long enough to starve vitest's
  worker RPC — the run printed `Error: [vitest-worker]: Timeout calling
  "onTaskUpdate"` and **exited non-zero with every test green**. That is a
  false-confidence failure mode worth naming: the summary said 45 passed.
- **stdout-only JSON parsing**, since bd writes advisories to stderr.
- **Partial writes**: every mutation is a single `bd` invocation (the reason for
  the tombstone design), so there is no multi-call window to half-apply. The two
  exceptions are documented in the code: `create` with deps issues `dep add`
  calls after the create, and `addDep`/`removeDep` with a reason issue a second
  `update` for `axi.dep_reasons`.

**Unknown — the supported version range.** This spike measured exactly one
version, `bd 1.3.0 (f45b249ce)`. Nothing here establishes behaviour on any other
version, and three of the measured behaviours are ones upstream could
reasonably change (the `delete --force` dependents bug, the
`--metadata`/`--unset-metadata` exclusivity, the reopen field clearing). The
adapter does **not** currently assert a `bd` version floor. Given that
Firstmate's own `FM_TASKS_AXI_MIN` exists for exactly this reason, a
`[beads] min_version` check plus a startup probe is the natural follow-up; it is
not implemented because the spec did not ask for it.

**Concurrent agents: Unknown.** Not measured. `bd update` offers
`--if-status`/`--if-assignee` compare-and-set guards that exit **13** on a stale
precondition, which is the primitive a future optimistic-concurrency layer
should use. The adapter currently does read-modify-write without them, so two
concurrent writers to the same issue's metadata can lose an update. The `revision`
field is **not** usable as a write guard: there is no `--if-revision` flag, and
it does not change on edge writes.

### OQ-11 — does `path` become `BEADS_DIR`, a `bd` path flag, or a cwd rule?

**Observed. A `bd` path flag — specifically `-C`, and it is worktree-safe.**

`[beads].path` names the `.beads` directory; the adapter passes
`-C <dirname(path)>`, bd's documented `git -C` equivalent ("Change to this
directory before running the command"). Verified working from an unrelated cwd,
and it **fails loudly** on a bad path: `Error: cannot use -C directory "...": no
such file or directory` (exit 1, no JSON). `--db` was rejected as the mechanism
because its default is "auto-discover `.beads/*.db`", which does not describe a
Dolt-backed store.

No `BEADS_DIR` environment variable appears in `bd`'s global flags.

**Linked worktrees work, and the reason is worth recording.** Measured directly:
`.beads/embeddeddolt` — the actual database directory — is **gitignored**, and
only `.gitignore`, `README.md`, `config.yaml` and `metadata.json` are tracked. A
linked worktree therefore has **no** `embeddeddolt`. Yet
`bd -C <linked-worktree> list --json` returned the same issue as the main tree.
The mechanism: the tracked `.beads/metadata.json` names the database
(`{"dolt_database": "DUE", "dolt_mode": "embedded", ...}`) and bd resolves it
**by name** from a machine-local Dolt data root, not from the worktree. So the
graph identity travels with the repo's tracked metadata, which is exactly the
property a worktree-per-session fleet needs.

**Unknown:** relocated Firstmate homes where the home is not inside the repo
owning `.beads`. `-C` addresses the repo root, so a home outside it must supply
an absolute `[beads].path`; that combination was not exercised beyond the
absolute-path tests.

### OQ-12 — is Dolt synchronization inside or outside adapter calls?

**Observed (what the adapter does); DECISION FOR SERGEI (ownership).**

The adapter performs **no** sync: no `bd dolt push`, no `bd dolt pull`, no
remote configuration. It sets `BD_NO_REMOTE_ADOPT=1` on every invocation, which
is load-bearing rather than incidental — without it bd *"adopts a remote from
git origin when a push or pull finds none configured, and adoption WRITES
`sync.remote` into the tracked `.beads/config.yaml` and commits it"*
(`scripts/bd_common.py:66-81`; three such bookkeeping commits per repo were
measured on another host). It also sets `BD_EXPORT_GIT_ADD=false`, which stops
bd staging its own export during a write and orphaning `.git/index.lock`. The
disposable graph confirmed the no-remote state: `⚠ No Dolt remote configured`.

`capabilities().realtimeSync` is therefore `false`, honestly.

| Option | Pros | Cons |
|---|---|---|
| **(a) Sync stays outside adapter calls** (what the code assumes) | Every adapter call is local, fast and credential-free, so no lifecycle operation can fail on a network or auth error; matches the fleet's existing split, where `scripts/bd_dolt_publish.py` is the publication path; keeps `realtimeSync: false` true | A Firstmate home can read stale state if nothing else is pushing/pulling; "who runs the sync" becomes an operational question the adapter cannot answer |
| **(b) Adapter owns pull/push policy** | A home is self-sufficient and always current | Puts credentials and network latency on the critical path of every `hold`/`done`; a sync failure becomes a lifecycle failure; bd's remote adoption would need careful suppression anyway to avoid writing a per-machine URL into tracked config |

**What this spike's code assumes:** (a) — synchronization is explicitly outside
adapter calls, because local operation needs no authentication and the fleet
already owns a publication path. **Not decided here.**

### OQ-13 — what conformance suite proves Firstmate's exact CLI contract?

**Observed, and it largely already exists.** Three layers, all exercised here:

1. **The fork's own compatibility probe** — `fm_tasks_axi_compatible_probe`
   (`bin/fm-tasks-axi-lib.sh:76`): version ≥ `FM_TASKS_AXI_MIN` (0.2.6) parsing
   to exactly three numeric parts, plus literal `--archive-body` in
   `update --help` and literal `[<id>...]` in `mv --help`. All pass; see §5.
2. **The fork's beads-gated test suites** — the 7 tests in
   `tests/fm-captain-hold-lifecycle.test.sh` guarded by
   `require_tasks_axi_beads`, which this adapter un-skips. These cover exactly
   the contract OQ-13 asks about: field rendering (`hold_kind: captain`,
   `kind: captain`), structured errors, holds, migration-marker and prefix id
   resolution, and evidence-bearing completion. 6 of 7 pass; see §5.
3. **This branch's 45 contract tests**, which freeze the mapping table itself
   and add the negative arms (NOT_FOUND, refused mutation on an unresolvable
   graph with no markdown fallback, UNSUPPORTED on a missing binary).

**Gaps not covered by any of the three (Unknown):** cross-home handoff (blocked
on OQ-8's `mv` defect), crash replay, and concurrent-agent behaviour (OQ-10).
Public-followup behaviour is covered at the store level here but not end-to-end
through Firstmate's Relay workflow.

---

## 5. Firstmate compatibility probe

Run from a **temp copy** of the fork (`/tmp/claude-1000/spike-nta1e/fm-copy`),
never the `/data/projects` checkout, with a `tasks-axi` shim first on `PATH`
executing this branch's build of the CLI entry point — `bin/tasks-axi.ts`,
emitted to the path `package.json`'s `bin` field declares.

### Version / feature probe — all pass

| Probe | Result |
|---|---|
| `tasks-axi --version` | `0.2.6` |
| `fm_tasks_axi_version_parts` | `[0 2 6]` |
| `fm_tasks_axi_update_has_archive_body` | rc 0 |
| `fm_tasks_axi_mv_has_multi_id` | rc 0 |
| `fm_tasks_axi_compatible_probe` | rc 0 |
| `fm_tasks_axi_compatible` | rc 0 |

**Backend resolution needs no fork change.** `fm_tasks_axi_backend_resolve`
returned `beads` from a `.tasks.toml` containing `backend = "beads"` plus a
`[beads]` table — the fork's awk reads only the root `backend` key and skips
every `[section]`, so the new table is invisible to it. The chief-of-staff
contract behaves correctly in both directions:

- `backlog-backend-required=beads` + resolved `beads` → rc 0, no error.
- `backlog-backend-required=beads` + resolved `markdown` → rc **2**:
  `config/backlog-backend-required=beads but tasks-axi resolves backend
  'markdown' ...; refusing the lifecycle operation (no markdown fallback)`.

### `tests/fm-tasks-axi.test.sh` — 9/9 pass, 0 skipped

All nine `ok -` lines, exit 0: regular code-root backlog reporting; code-root
backlog linked elsewhere with a forked archive; silence when the code root is
the home; bare-tasks-axi link replacement; relative body files written/held/
archived/read through to the home; home backlog pinned over an ambient
`TASKS_AXI_FILE`; refusal of caller `--file`, a symlinked home backlog and an
unresolvable home; refusal of `add --start` with plain `add`/`start` passing
through; single-home layout addressing its own code-root backlog.

### `tests/fm-captain-hold-lifecycle.test.sh` — 52 pass, 1 fail, 0 skipped

**This is the result the research doc asked for** ("run Firstmate's existing
Beads fixtures without their markdown-only skips"). With a control run on the
unmodified base-commit CLI:

| Run | ok | not ok | skipped-on-markdown-only |
|---|---|---|---|
| Base `9401ff8` (markdown only) | 53 | 0 | **7** |
| This branch | 52 | 1 | **0** |

The adapter un-skips **all 7** beads-gated tests. **6 of the 7 pass:**

| Previously skipped test | This branch |
|---|---|
| verify against a beads-migrated hold | **pass** |
| verify against a prefix-migrated hold | **pass** |
| prefer a marker-noted row over a prefix namesake | **pass** |
| verify an unresolvable beads legacy id | **pass** |
| complete against a beads-migrated hold | **pass** |
| verify a derived pre-collapse key | **pass** |
| captain-hold create under `due.required` without `types.custom` | **fail** |

Also passing (and not previously skipped): *"captain-hold mutations address the
beads backend without a markdown override"*, which asserts no ` --file ` override
reaches a beads home.

### The one failure, and why it is not this adapter's

**`not ok - bd created a task without --due; the due.required fixture is not in
force`** (`tests/fm-captain-hold-lifecycle.test.sh:648`).

The assertion is about **`bd`'s own behaviour**, not tasks-axi's. The test
appends `due:\n    required: true` to the fixture's `.beads/config.yaml` and
asserts that `bd create --type task` *without* `--due` then fails
(line 647-649). Two controls:

- **Control 1 (direct, no tasks-axi involved at all):** on a fresh disposable
  graph with `due:\n    required: true` appended to `.beads/config.yaml`,
  `bd create "raw task" --id DUE-rawtask --type task --json` **exited 0 and
  created the issue**. So on bd 1.3.0 that config key does not gate creation,
  and the test's premise is false independent of tasks-axi.
- **Control 2 (base commit):** with the unmodified markdown-only CLI the same
  test reports `ok - skipped on markdown-only tasks-axi: captain-hold create
  under due.required without types.custom`. The base run's green **includes a
  skip of this very test**.

So this branch did not break the test — it made it **reachable**, and it then
fails on a bd-version behaviour assertion. The fix belongs in `bd` (honour
`due.required`) or in the fork's fixture/assertion (match bd 1.3.0), **neither
of which is in this spike's writable scope**: the Firstmate fork is read-only
per the brief and `bd` is a third-party binary. I did not fix it, and I could not
file a Beads issue either, since the brief forbids touching any existing
`.beads/` store. **It needs filing by aih-3**, with Control 1 as the evidence.

---

## 6. Where the ask and the measured code disagree

1. **`mv` is markdown-only at the command layer** (OQ-8). The single-id path
   would export a task out of Beads into a markdown file, violating "Beads stays
   the SOLE task system of record"; the multi-id path throws `UNSUPPORTED`,
   breaking the secondmate handoff the fork requires. Not fixable from the
   `Store` seam. **The most consequential finding in this spike.**
2. **"reopen without losing original completion evidence" is impossible using
   bd's native fields** (OQ-7): `-s open` clears `closed_at` *and*
   `close_reason`. Satisfied only by mirroring the stamp into metadata.
3. **`bd delete --force` contradicts its own documentation** and will strand
   dependents, so the markdown backend's refusal had to be reimplemented in the
   adapter rather than delegated to bd.
4. **`--metadata` and `--unset-metadata` are mutually exclusive**, so "holds
   encoded atomically" (OQ-4) is achievable only via null tombstones, not by
   unsetting keys.
5. **The research doc's field list for `bd show --json` is incomplete.** It did
   not mention `started_at`, `closed_at`, `close_reason` or `schema_version`,
   and did not record that the response is an array or that `dependencies` has
   two shapes.
6. **`bd create` has no `--metadata`-adjacent unset flag and no
   `--set-metadata`/`--add-label`**, so create and update need different
   metadata call shapes.

---

## 7. Reproducing

```bash
cd /home/ubuntu/.local/state/ai-harness/spikes/tasks-axi-wt-beads
pnpm install --frozen-lockfile
npm run build && npm test && npm run lint

# just the adapter's contract tests (needs `bd` on PATH; skips by name without it)
npx vitest run test/backends/beads.test.ts
```

The contract tests create and delete their own disposable graph under the OS temp
directory. They touch no Dolt server and no existing `.beads/` store.
