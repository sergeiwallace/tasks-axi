/**
 * Shared gate for the suites that drive a real `bd`.
 *
 * The Beads contract suites self-skip when `bd` is absent, which is right on a
 * laptop and wrong in CI: a broken install or a PATH regression would drop the
 * whole backend's coverage and still report green. `REQUIRE_BD` turns that
 * skip into a hard failure, so CI has to say out loud that it ran them.
 */
export interface BdAvailabilityEnv {
  REQUIRE_BD?: string | undefined;
}

/** Is `REQUIRE_BD` asking for a failure rather than a skip? */
export function bdRequired(env: BdAvailabilityEnv): boolean {
  const value = env.REQUIRE_BD;
  return value !== undefined && value !== "" && value !== "0";
}

/**
 * Resolve whether the bd-backed suites may skip. Returns true when `bd`
 * answered, false when it did not and skipping is allowed, and THROWS when
 * `REQUIRE_BD` is set and bd is unavailable — raised at module load so the
 * whole file fails to collect rather than reporting a quiet skip.
 */
export function bdAvailability(
  probe: () => boolean,
  env: BdAvailabilityEnv,
): boolean {
  const available = probe();
  if (!available && bdRequired(env)) {
    throw new Error(
      "REQUIRE_BD is set but `bd` is not runnable, so the Beads contract " +
        "suites would silently skip. Install bd (CI pins a version) or " +
        "unset REQUIRE_BD to allow the skip.",
    );
  }
  return available;
}
