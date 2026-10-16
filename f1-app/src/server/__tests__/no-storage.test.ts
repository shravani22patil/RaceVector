import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminRequest } from "../admin";
import { assembleBundle } from "../bundle";
import { handleF1Request, normalizeKey, resetResourceCacheForTests, resolveResource, type WorkerContext } from "../openf1-cache";
import { resetSessionStateMemo } from "../session-state";
import { handleSeasonTrendsRequest } from "../season-trends";
import { handleShareImageRead, handleShareImageUpload } from "../share-image";

describe("no-persistent-storage deployment", () => {
  beforeEach(() => {
    resetResourceCacheForTests();
    resetSessionStateMemo();
    vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps telemetry date filters in normalized upstream cache keys", () => {
    expect(normalizeKey("/car_data?session_key=42&date>=2026-01-01")).toBe(
      "car_data?date>=2026-01-01&session_key=42",
    );
  });

  it("fetches missing data directly from OpenF1 and reuses the bounded isolate cache", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://api.openf1.org/v1/meetings?year=2099");
      return new Response('[{"meeting_key":1}]', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await resolveResource("/meetings?year=2099", {}, null);
    const second = await resolveResource("/meetings?year=2099", {}, null);

    expect(first.xcache).toBe("MISS");
    expect(second.xcache).toBe("HIT");
    expect(second.body).toBe('[{"meeting_key":1}]');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves race data when the Analytics Engine binding is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('[{"meeting_key":1}]', { status: 200 })));

    const response = await handleF1Request(
      new Request("https://racevector.test/api/f1/meetings?year=2099"),
      {},
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ meeting_key: 1 }]);
  });

  it("continues serving race data when Analytics Engine writes fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('[{"meeting_key":1}]', { status: 200 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const writeDataPoint = vi.fn(() => { throw new Error("analytics unavailable"); });

    const response = await handleF1Request(
      new Request("https://racevector.test/api/f1/meetings?year=2098"),
      { ANALYTICS: { writeDataPoint } },
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ meeting_key: 1 }]);
    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("spaces upstream starts to stay within the public API request rate", async () => {
    const starts: number[] = [];
    const fetchMock = vi.fn(async () => {
      starts.push(Date.now());
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      resolveResource("/meetings?year=2097", {}, null),
      resolveResource("/meetings?year=2098", {}, null),
      resolveResource("/meetings?year=2099", {}, null),
    ]);

    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(300);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(300);
  });

  it("does not retain oversized responses in isolate memory", async () => {
    const fetchMock = vi.fn(async () => new Response("x".repeat(1_000_001), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await resolveResource("/meetings?year=2099", {}, null);
    await resolveResource("/meetings?year=2099", {}, null);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps session bundles honest about intervals without a persistent artifact", async () => {
    const year = new Date().getUTCFullYear();
    const session = {
      session_key: 12345,
      meeting_key: 234,
      date_start: `${year - 1}-01-01T12:00:00Z`,
      date_end: `${year - 1}-01-01T14:00:00Z`,
      year,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const endpoint = url.pathname.split("/").pop();
      if (endpoint === "sessions" && url.searchParams.has("year")) {
        return new Response(JSON.stringify([session]), { status: 200 });
      }
      if (endpoint === "sessions" && url.searchParams.has("session_key")) {
        return new Response(JSON.stringify([session]), { status: 200 });
      }
      if (endpoint === "sessions" && url.searchParams.has("meeting_key")) {
        return new Response(JSON.stringify([{ ...session, session_name: "Race" }]), { status: 200 });
      }
      if (endpoint === "meetings") return new Response(JSON.stringify([{ meeting_key: 234 }]), { status: 200 });
      if (endpoint === "drivers") return new Response(JSON.stringify([{ driver_number: 1 }]), { status: 200 });
      if (endpoint === "laps") return new Response(JSON.stringify([{ driver_number: 1, date_start: session.date_start }]), { status: 200 });
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx: WorkerContext = { waitUntil: () => {} };

    const result = await assembleBundle(12345, {}, ctx, "https://racevector.test");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.intervals).toBe("none");
    expect(result.meta.missing).toContain("intervals");
    expect(JSON.parse(result.body).intervals).toEqual([]);
  });

  it("reports stored-file and precomputed-trends features as unavailable", async () => {
    const upload = await handleShareImageUpload({
      request: new Request("https://racevector.test/api/share/upload", { method: "POST" }),
    });
    const image = await handleShareImageRead({
      url: new URL("https://racevector.test/share/img/abcdef0123456789.png"),
    });
    const trends = await handleSeasonTrendsRequest({
      url: new URL("https://racevector.test/api/season-trends/2025"),
    });

    expect(upload.status).toBe(503);
    expect(image?.status).toBe(503);
    expect(trends?.status).toBe(503);
    await expect(upload.json()).resolves.toMatchObject({ error: expect.stringContaining("persistent storage") });
  });

  it("does not claim admin cache operations succeeded without persistent storage", async () => {
    const response = await handleAdminRequest(
      new Request("https://racevector.test/api/admin/purge?session_key=42", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" },
      }),
      { ADMIN_TOKEN: "test-token" },
    );

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({
      error: expect.stringContaining("persistent storage"),
    });
  });
});
