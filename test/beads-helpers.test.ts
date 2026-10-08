import { describe, expect, it } from "vitest";
import { bdAvailability, bdRequired } from "./beads-helpers.js";

/**
 * The gate itself, with a stubbed probe, so the CI-only behaviour is checked
 * on every machine rather than only where `bd` happens to be missing.
 */
describe("bd availability gate", () => {
  it("test_bd_availability_when_bd_runs_then_suites_run", () => {
    expect(bdAvailability(() => true, {})).toBe(true);
    expect(bdAvailability(() => true, { REQUIRE_BD: "1" })).toBe(true);
  });

  it("test_bd_availability_when_bd_absent_and_not_required_then_skip_is_allowed", () => {
    expect(bdAvailability(() => false, {})).toBe(false);
    expect(bdAvailability(() => false, { REQUIRE_BD: "" })).toBe(false);
    expect(bdAvailability(() => false, { REQUIRE_BD: "0" })).toBe(false);
  });

  it("test_bd_availability_when_bd_absent_and_required_then_throws_naming_the_variable", () => {
    expect(() => bdAvailability(() => false, { REQUIRE_BD: "1" })).toThrowError(
      /REQUIRE_BD is set but `bd` is not runnable/,
    );
  });

  it("test_bd_required_when_variable_is_set_to_anything_truthy_then_true", () => {
    expect(bdRequired({ REQUIRE_BD: "1" })).toBe(true);
    expect(bdRequired({ REQUIRE_BD: "yes" })).toBe(true);
    expect(bdRequired({})).toBe(false);
    expect(bdRequired({ REQUIRE_BD: undefined })).toBe(false);
  });
});
