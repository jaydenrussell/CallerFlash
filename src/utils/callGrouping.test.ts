import { describe, it, expect } from "vitest";
import { getCallSection, groupCallsBySection, type CallSectionKey } from "./callGrouping";
import type { CallRecord } from "../store/useAppStore";

const now = new Date("2025-06-15T12:00:00Z");

function makeCall(timestamp: Date, id: string): CallRecord {
  return {
    id,
    callerNumber: "555-0100",
    callerName: "Alice",
    timestamp,
    duration: 0,
    direction: "inbound",
  };
}

function daysAgo(days: number, hour = 10): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, hour);
}

describe("getCallSection", () => {
  it.each([
    [daysAgo(0), "today"],
    [daysAgo(1), "yesterday"],
    [daysAgo(3), "last7"],
    [daysAgo(7), "last7"],
    [daysAgo(8), "last30"],
    [daysAgo(30), "last30"],
    [daysAgo(31), "older"],
  ] as [Date, CallSectionKey][])("maps %s to %s", (ts, expected) => {
    expect(getCallSection(ts, now)).toBe(expected);
  });
});

describe("groupCallsBySection", () => {
  it("groups calls into ordered sections", () => {
    const calls = [
      makeCall(daysAgo(31), "old"),
      makeCall(daysAgo(0), "today"),
      makeCall(daysAgo(1), "yesterday"),
      makeCall(daysAgo(10), "last30"),
    ];
    const sections = groupCallsBySection(calls, now);
    expect(sections.map((s) => s.key)).toEqual(["today", "yesterday", "last30", "older"]);
    expect(sections[0].calls.map((c) => c.id)).toEqual(["today"]);
    expect(sections[3].calls.map((c) => c.id)).toEqual(["old"]);
  });

  it("omits empty sections", () => {
    const sections = groupCallsBySection([makeCall(daysAgo(5), "week")], now);
    expect(sections.map((s) => s.key)).toEqual(["last7"]);
  });

  it("returns empty array for empty input", () => {
    expect(groupCallsBySection([], now)).toEqual([]);
  });
});
