import { describe, it, expect } from "vitest";
import {
  redactKeyedValue,
  redactMessage,
  sanitizeCallerNumberForClipboard,
  sanitizeSipServer,
  isSafeExternalUrl,
} from "./secretRedactor";

describe("redactKeyedValue", () => {
  it("redacts known sensitive keys", () => {
    expect(redactKeyedValue("password", "supersecret")).toBe("***REDACTED***");
    expect(redactKeyedValue("sip_password", "test")).toBe("***REDACTED***");
    expect(redactKeyedValue("AUTH_USERNAME", "admin")).toBe("***REDACTED***");
    expect(redactKeyedValue("api_key", "abc123")).toBe("***REDACTED***");
  });

  it("passes through non-sensitive keys", () => {
    expect(redactKeyedValue("username", "alice")).toBe("alice");
    expect(redactKeyedValue("server", "sip.example.com")).toBe("sip.example.com");
    expect(redactKeyedValue("port", "5060")).toBe("5060");
  });
});

describe("redactMessage", () => {
  it("redacts bearer tokens", () => {
    const msg = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.dGVzdA";
    expect(redactMessage(msg)).toContain("***REDACTED***");
  });

  it("redacts long hex blobs", () => {
    const hex = "a".repeat(50);
    expect(redactMessage(hex)).toBe("***REDACTED***");
  });

  it("redacts credential assignments in free-form text", () => {
    expect(redactMessage("register failed pass=hunter2")).toBe(
      "register failed pass=***REDACTED***"
    );
    expect(redactMessage("auth error password: hunter2")).toBe(
      "auth error password=***REDACTED***"
    );
    expect(redactMessage("token=abc123 rejected")).toBe("token=***REDACTED*** rejected");
  });

  it("does not redact words merely containing key substrings", () => {
    expect(redactMessage("supported=true and tokens remaining: 5")).toBe(
      "supported=true and tokens remaining: 5"
    );
  });

  it("passes through safe messages", () => {
    const msg = "Registered successfully";
    expect(redactMessage(msg)).toBe("Registered successfully");
  });
});

describe("sanitizeCallerNumberForClipboard", () => {
  it("strips non-digit characters", () => {
    expect(sanitizeCallerNumberForClipboard("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("adds leading + if missing", () => {
    expect(sanitizeCallerNumberForClipboard("15551234567")).toBe("+15551234567");
  });

  it("handles empty input", () => {
    expect(sanitizeCallerNumberForClipboard("")).toBe("+");
  });

  it("strips HTML injection", () => {
    expect(sanitizeCallerNumberForClipboard("<script>alert(1)</script>")).toBe("+1");
  });

  it("truncates to 20 chars", () => {
    const long = "1".repeat(30);
    expect(sanitizeCallerNumberForClipboard(long).length).toBe(20);
  });
});

describe("sanitizeSipServer", () => {
  it("passes through valid hostname", () => {
    expect(sanitizeSipServer("sip.example.com")).toBe("sip.example.com");
  });

  it("passes through IP address", () => {
    expect(sanitizeSipServer("192.168.1.1")).toBe("192.168.1.1");
  });

  it("strips path components", () => {
    expect(sanitizeSipServer("example.com/evil")).toBe("");
  });

  it("strips userinfo", () => {
    expect(sanitizeSipServer("user@example.com")).toBe("");
  });

  it("strips scheme", () => {
    expect(sanitizeSipServer("sip:user@example.com")).toBe("");
  });

  it("trims whitespace", () => {
    expect(sanitizeSipServer("  example.com  ")).toBe("example.com");
  });
});

describe("isSafeExternalUrl", () => {
  it("accepts https URLs", () => {
    expect(isSafeExternalUrl("https://github.com")).toBe(true);
  });

  it("accepts http URLs", () => {
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
  });

  it("rejects javascript URLs", () => {
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects file URLs", () => {
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects localhost", () => {
    expect(isSafeExternalUrl("http://localhost:3000")).toBe(false);
  });
});
