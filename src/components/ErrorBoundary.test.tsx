import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

// External flag the child reads at render time, so the test can "fix" the
// underlying fault before clicking Reload.
let bombArmed = false;

function Bomb() {
  if (bombArmed) {
    throw new Error("kaboom: stable channel exploded");
  }
  return <p>all good</p>;
}

describe("ErrorBoundary", () => {
  it("renders children normally", () => {
    bombArmed = false;
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );
    expect(screen.getByText("all good")).toBeTruthy();
  });

  it("shows the error and recovers via the reload button", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    bombArmed = true;
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );
    expect(screen.getByText(/Something went wrong/)).toBeTruthy();
    expect(screen.getByText(/kaboom/)).toBeTruthy();
    bombArmed = false;
    fireEvent.click(screen.getByRole("button", { name: /Reload page/i }));
    expect(screen.getByText("all good")).toBeTruthy();
    spy.mockRestore();
  });
});
