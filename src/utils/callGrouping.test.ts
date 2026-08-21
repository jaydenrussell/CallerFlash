import { describe, it, expect } from "vitest";
import { getDayKey, getCallSectionLabel, groupCallsBySection } from "./callGrouping";
import type { CallRecord } from "../store/useAppStore";

const now = new Date(2025, 5, 15, 12, 0, 0);

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

describe("getDayKey", () => {
  it("formats local calendar day as YYYY-MM-DD", () => {
    expect(getDayKey(new Date(2025, 5, 15))).toBe("2025-06-15");
    expect(getDayKey(new Date(2025, 0, 3))).toBe("2025-01-03");
  });
});

describe("getCallSectionLabel", () => {
  it("labels today and yesterday", () => {
    expect(getCallSectionLabel("2025-06-15", now, "en-US")).toBe("Today");
    expect(getCallSectionLabel("2025-06-14", now, "en-US")).toBe("Yesterday");
  });

  it("labels older days with weekday and date", () => {
    expect(getCallSectionLabel("2025-06-12", now, "en-US")).toBe("Thursday, June 12");
  });

  it("includes year for other years", () => {
    expect(getCallSectionLabel("2024-06-12", now, "en-US")).toBe("Wednesday, June 12, 2024");
  });
});

describe("groupCallsBySection", () => {
  it("groups calls by calendar day in descending order", () => {
    const calls = [
      makeCall(new Date(2025, 5, 15, 9, 0), "a"),
      makeCall(new Date(2025, 5, 15, 8, 0), "b"),
      makeCall(new Date(2025, 5, 14, 20, 0), "c"),
      makeCall(new Date(2025, 5, 10, 10, 0), "d"),
    ];
    const sections = groupCallsBySection(calls, now, "en-US");
    expect(sections.map((s) => s.key)).toEqual(["2025-06-15", "2025-06-14", "2025-06-10"]);
    expect(sections[0].label).toBe("Today");
    expect(sections[0].calls.map((c) => c.id)).toEqual(["a", "b"]);
    expect(sections[1].label).toBe("Yesterday");
    expect(sections[2].label).toBe("Tuesday, June 10");
  });

  it("returns empty array for empty input", () => {
    expect(groupCallsBySection([], now)).toEqual([]);
  });
});
