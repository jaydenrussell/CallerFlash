import { describe, it, expect } from "vitest";
import { isUpdateCheckDue, updateCheckIntervalMs } from "./updateSchedule";

const NOW = new Date("2026-08-23T12:00:00Z").getTime();

describe("isUpdateCheckDue", () => {
  it("never schedules when frequency is off", () => {
    expect(isUpdateCheckDue("off", null, NOW)).toBe(false);
    expect(isUpdateCheckDue("off", new Date(NOW - 10 * 24 * 60 * 60 * 1000), NOW)).toBe(false);
  });

  it("checks immediately when no previous check exists", () => {
    expect(isUpdateCheckDue("daily", null, NOW)).toBe(true);
    expect(isUpdateCheckDue("weekly", undefined, NOW)).toBe(true);
  });

  it("does not fire before the daily interval elapses", () => {
    const recent = new Date(NOW - (updateCheckIntervalMs("daily")! - 60_000));
    expect(isUpdateCheckDue("daily", recent, NOW)).toBe(false);
  });

  it("fires exactly at the daily boundary", () => {
    const boundary = new Date(NOW - updateCheckIntervalMs("daily")!);
    expect(isUpdateCheckDue("daily", boundary, NOW)).toBe(true);
  });

  it("honors weekly and monthly intervals", () => {
    const almostWeek = new Date(NOW - (updateCheckIntervalMs("weekly")! - 60_000));
    const atWeek = new Date(NOW - updateCheckIntervalMs("weekly")!);
    expect(isUpdateCheckDue("weekly", almostWeek, NOW)).toBe(false);
    expect(isUpdateCheckDue("weekly", atWeek, NOW)).toBe(true);

    const almostMonth = new Date(NOW - (updateCheckIntervalMs("monthly")! - 60_000));
    const atMonth = new Date(NOW - updateCheckIntervalMs("monthly")!);
    expect(isUpdateCheckDue("monthly", almostMonth, NOW)).toBe(false);
    expect(isUpdateCheckDue("monthly", atMonth, NOW)).toBe(true);
  });

  it("treats an invalid timestamp as due rather than blocking checks forever", () => {
    const invalid = new Date("not-a-date");
    expect(isUpdateCheckDue("daily", invalid, NOW)).toBe(true);
  });
});
