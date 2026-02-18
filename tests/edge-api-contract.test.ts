/**
 * Edge API contract tests: URL builder (no duplicated /edge), UUID validation,
 * registration lifecycle, and X-Edge-Id header on authenticated requests.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { RestClient, RestResponseError } from "../src/cloud/rest-client.ts";
import { isValidUuid } from "../src/utils/uuid.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// URL BUILDER — no duplicated /edge/ segment
// ═══════════════════════════════════════════════════════════════════════════════

describe("Edge API contract: URL builder", () => {
  it("builds edge base URL without duplicating /edge when apiUrl has no /edge", () => {
    const client = new RestClient({ apiUrl: "http://localhost:4000/api/v1" });
    const base = client.getEdgeApiBase();
    expect(base).toBe("http://localhost:4000/api/v1/edge");
    expect(base + "/register").not.toContain("edge/edge");
    expect(base + "/sessions").not.toContain("edge/edge");
    expect(base + "/events").not.toContain("edge/edge");
    expect(base + "/config").not.toContain("edge/edge");
    expect(base + "/devices/status").not.toContain("edge/edge");
  });

  it("builds edge base URL without duplicating /edge when apiUrl ends with /edge", () => {
    const client = new RestClient({ apiUrl: "http://localhost:4000/api/v1/edge" });
    const base = client.getEdgeApiBase();
    expect(base).toBe("http://localhost:4000/api/v1/edge");
    expect(base + "/register").toBe("http://localhost:4000/api/v1/edge/register");
    expect((base + "/register").includes("edge/edge")).toBe(false);
  });

  it("produces correct full paths for all child routes", () => {
    const client = new RestClient({ apiUrl: "https://api.example.com/api/v1" });
    const base = client.getEdgeApiBase();
    expect(base).toBe("https://api.example.com/api/v1/edge");
    const paths = ["/register", "/sessions", "/events", "/events/batch", "/config", "/devices/status"];
    for (const p of paths) {
      const full = base + p;
      expect(full).toBe(`https://api.example.com/api/v1/edge${p}`);
      expect(full).not.toContain("edge/edge");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UUID VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe("Edge API contract: UUID validation", () => {
  it("accepts valid RFC 4122 UUIDs", () => {
    expect(isValidUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidUuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true);
    expect(isValidUuid("6BA7B810-9DAD-11D1-80B4-00C04FD430C8")).toBe(true);
  });

  it("rejects custom edge IDs (no UUID)", () => {
    expect(isValidUuid("edge-123")).toBe(false);
    expect(isValidUuid("edge-1700000000000-1")).toBe(false);
    expect(isValidUuid("")).toBe(false);
  });

  it("rejects malformed strings", () => {
    expect(isValidUuid("550e8400-e29b-41d4-a716")).toBe(false);
    expect(isValidUuid("not-a-uuid")).toBe(false);
    expect(isValidUuid(null as unknown as string)).toBe(false);
    expect(isValidUuid(undefined as unknown as string)).toBe(false);
    expect(isValidUuid(123 as unknown as string)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTRATION LIFECYCLE (mocked fetch)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Edge API contract: registration lifecycle", () => {
  const validUuid = "550e8400-e29b-41d4-a716-446655440000";
  const registerPayload = {
    edgeId: null as string | null,
    siteId: "site-001",
    siteName: "Test Site",
    version: "0.3.0",
    capabilities: ["rest", "tcp"],
  };

  it("first registration sends edgeId null and receives UUID", async () => {
    const client = new RestClient({
      apiUrl: "http://test/api/v1",
      edgeIdentity: null,
      autoStart: false,
    });
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedBody: unknown = null;
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      try {
        capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      } catch {
        capturedBody = null;
      }
      if (capturedUrl.includes("/register") && (init?.method === "POST")) {
        return new Response(
          JSON.stringify({
            edgeId: validUuid,
            siteId: "site-001",
            siteName: "Test Site",
            config: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      const result = await client.register(registerPayload);
      expect(result.edgeId).toBe(validUuid);
      expect(isValidUuid(result.edgeId)).toBe(true);
      expect(capturedBody).not.toBeNull();
      expect((capturedBody as { edgeId?: string }).edgeId).toBeNull();
      expect(capturedUrl).not.toContain("edge/edge");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("re-registration with valid UUID sends edgeId in body", async () => {
    const client = new RestClient({
      apiUrl: "http://test/api/v1",
      edgeIdentity: { edgeId: validUuid, siteId: "site-001", siteName: "Test", registeredAt: new Date() },
      autoStart: false,
    });
    let capturedBody: unknown = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      try {
        capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      } catch {
        capturedBody = null;
      }
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/register") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            edgeId: validUuid,
            siteId: "site-001",
            siteName: "Test Site",
            config: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      await client.register({
        ...registerPayload,
        edgeId: validUuid,
      });
      expect((capturedBody as { edgeId?: string }).edgeId).toBe(validUuid);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("register throws RestResponseError with status and bodyText on 400", async () => {
    const client = new RestClient({
      apiUrl: "http://test/api/v1",
      autoStart: false,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/register")) {
        return new Response(
          JSON.stringify({ error: "Invalid edgeId format; must be a valid UUID" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      await client.register({ ...registerPayload, edgeId: "invalid-id" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(RestResponseError);
      const e = err as RestResponseError;
      expect(e.status).toBe(400);
      expect(e.bodyText).toContain("Invalid");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("401 with invalid edge triggers ensureEdgeIdentity and single retry", async () => {
    const client = new RestClient({
      apiUrl: "http://test/api/v1",
      edgeIdentity: {
        edgeId: "550e8400-e29b-41d4-a716-446655440000",
        siteId: "site-001",
        siteName: "Test",
        registeredAt: new Date(),
      },
      autoStart: false,
      ensureEdgeIdentity: async () => ({
        edgeId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        siteId: "site-001",
        siteName: "Test",
        registeredAt: new Date(),
      }),
    });
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      callCount++;
      if (u.includes("/config")) {
        if (callCount === 1) {
          return new Response(
            JSON.stringify({ error: "Missing/Invalid X-Edge-Id" }),
            { status: 401, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ sessionPollIntervalMs: 5000 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      await client.getConfig();
      expect(callCount).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION-STYLE: POST event includes X-Edge-Id UUID header
// ═══════════════════════════════════════════════════════════════════════════════

describe("Edge API contract: event POST with X-Edge-Id", () => {
  const validUuid = "550e8400-e29b-41d4-a716-446655440000";

  it("includes X-Edge-Id header with UUID when posting event", async () => {
    const client = new RestClient({
      apiUrl: "http://test/api/v1",
      edgeIdentity: {
        edgeId: validUuid,
        siteId: "site-001",
        siteName: "Test",
        registeredAt: new Date(),
      },
      autoStart: false,
      queueWhenOffline: false,
    });
    let capturedHeaders: Headers | undefined;
    let capturedUrl = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      capturedUrl = u;
      if (u.includes("/config")) {
        return new Response(JSON.stringify({ sessionPollIntervalMs: 5000 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/events") && init?.method === "POST") {
        capturedHeaders = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers as HeadersInit);
        return new Response(
          JSON.stringify({ cloudEventId: "evt-1", status: "accepted" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      await client.getConfig();
      await client.postEvent({
        localEventId: "local-1",
        deviceId: "SCALE-01",
        pluCode: "00001",
        productName: "KIYMA",
        weightGrams: 1500,
        barcode: "8690123456789",
        scaleTimestamp: new Date().toISOString(),
        cloudSessionId: null,
        offlineBatchId: null,
      });
      expect(capturedHeaders).toBeDefined();
      const edgeIdHeader = capturedHeaders!.get("X-Edge-Id");
      expect(edgeIdHeader).toBe(validUuid);
      expect(isValidUuid(edgeIdHeader!)).toBe(true);
      expect(capturedUrl).not.toContain("edge/edge");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
