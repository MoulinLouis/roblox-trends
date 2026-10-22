import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { clearResponseCache, fetchJson, getHttpRequestMetrics, pacedEndpoint, parseRateLimitDelayMs } from "./http";

describe("HTTP rate-limit timing", () => {
  it("uses the longest server-provided delay", () => {
    const headers = new Headers({ "retry-after": "5", "x-ratelimit-reset": "12" });
    expect(parseRateLimitDelayMs(headers)).toBe(12_000);
  });

  it("supports an HTTP date in Retry-After", () => {
    const now = Date.parse("2026-08-10T20:00:00Z");
    const headers = new Headers({ "retry-after": "Mon, 10 Aug 2026 20:00:20 GMT" });
    expect(parseRateLimitDelayMs(headers, now)).toBe(20_000);
  });

  it("returns zero when rate-limit timing headers are absent", () => {
    expect(parseRateLimitDelayMs(new Headers())).toBe(0);
  });
});

const detailsEndpoint = "games.roblox.com/v1/games";

describe("pacedEndpoint", () => {
  it("matches the game details path exactly, whatever the query string", () => {
    expect(pacedEndpoint(new URL("https://games.roblox.com/v1/games?universeIds=1,2,3"))).toBe(detailsEndpoint);
    expect(pacedEndpoint(new URL("https://games.roblox.com/v1/games"))).toBe(detailsEndpoint);
  });

  it("paces every path under a key ending in /* as one endpoint", () => {
    const recommendations = "games.roblox.com/v1/games/recommendations/game/*";
    expect(pacedEndpoint(new URL("https://games.roblox.com/v1/games/recommendations/game/1?maxRows=6"))).toBe(recommendations);
    expect(pacedEndpoint(new URL("https://games.roblox.com/v1/games/recommendations/game/10769903740"))).toBe(recommendations);
  });

  it.each([
    "https://games.roblox.com/v1/games/votes?universeIds=1,2,3",
    "https://games.roblox.com/v1/games/recommendations/algorithm?x=1",
    "https://games.roblox.com/v1/gamesx?universeIds=1",
    "https://apis.roblox.com/v1/games?universeIds=1",
  ])("leaves %s to its host's spacing", (url) => {
    expect(pacedEndpoint(new URL(url))).toBeUndefined();
  });
});

describe("fetchJson pacing", () => {
  const detailsUrl = (id: number) => `https://games.roblox.com/v1/games?universeIds=${id}`;
  const votesUrl = (id: number) => `https://games.roblox.com/v1/games/votes?universeIds=${id}`;
  // When each request started on the fake clock, in milliseconds after the first one.
  let started: { path: string; at: number }[];
  let respond: (url: URL) => Response;
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // No retry jitter.
    vi.spyOn(Math, "random").mockReturnValue(0);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    started = [];
    respond = () => Response.json({ data: [] });
    const origin = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        started.push({ path: url.pathname, at: Date.now() - origin });
        return respond(url);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearResponseCache();
  });

  // Sends the requests one after another, as the collectors do, and lets the fake clock run until they are done. A
  // request that fails is left to the assertions on `started` and the metrics.
  async function inSequence(...requests: (() => Promise<unknown>)[]): Promise<void> {
    const run = (async () => {
      for (const request of requests) await request().catch(() => undefined);
    })();
    await vi.runAllTimersAsync();
    await run;
  }

  function slowdownLogs(): string[] {
    return warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("Slowed down"));
  }

  const tooManyRequests = (headers?: HeadersInit) => new Response("", { status: 429, statusText: "Too Many Requests", headers });

  it("spaces game details requests by their endpoint's interval and votes requests by the host's only", async () => {
    await inSequence(
      () => fetchJson(detailsUrl(1)),
      () => fetchJson(votesUrl(1)),
      () => fetchJson(votesUrl(2)),
      () => fetchJson(detailsUrl(2)),
      () => fetchJson(votesUrl(3)),
    );
    expect(started).toEqual([
      { path: "/v1/games", at: 0 },
      { path: "/v1/games/votes", at: 500 },
      { path: "/v1/games/votes", at: 1_000 },
      { path: "/v1/games", at: 7_000 },
      { path: "/v1/games/votes", at: 7_500 },
    ]);
  });

  it("slows a rate-limited endpoint down for the rest of the process and logs the new spacing once", async () => {
    let detailsCalls = 0;
    respond = (url) => (url.pathname === "/v1/games" && (detailsCalls += 1) === 1 ? tooManyRequests() : Response.json({ data: [] }));
    await inSequence(
      () => fetchJson(detailsUrl(1)),
      () => fetchJson(detailsUrl(2)),
      () => fetchJson(votesUrl(1)),
    );
    // The retry waits for the new 10.5 s spacing, longer than the 5 s backoff; votes keep the host's 0.5 s.
    expect(started).toEqual([
      { path: "/v1/games", at: 0 },
      { path: "/v1/games", at: 10_500 },
      { path: "/v1/games", at: 21_000 },
      { path: "/v1/games/votes", at: 21_500 },
    ]);
    expect(slowdownLogs()).toHaveLength(1);
    expect(JSON.parse(slowdownLogs()[0])).toMatchObject({
      level: "warn",
      details: { endpoint: detailsEndpoint, previousIntervalMs: 7_000, intervalMs: 10_500 },
    });
  });

  it("still waits for the server's reset when it outlasts the new spacing", async () => {
    let detailsCalls = 0;
    respond = () => ((detailsCalls += 1) === 1 ? tooManyRequests({ "retry-after": "40" }) : Response.json({ data: [] }));
    await inSequence(
      () => fetchJson(detailsUrl(1)),
      () => fetchJson(detailsUrl(2)),
    );
    expect(started.map((request) => request.at)).toEqual([0, 40_000, 50_500]);
  });

  it("caps the slowdown at the maximum endpoint spacing", async () => {
    respond = () => tooManyRequests();
    await inSequence(...Array.from({ length: 6 }, (_, index) => () => fetchJson(detailsUrl(index + 1), { retries: 0 })));
    // 7 s, then 10.5, 15.75, 23.625 and 35.4375 s capped at 30 s: one log per new spacing, none once it stays capped.
    expect(started.map((request) => request.at)).toEqual([0, 10_500, 26_250, 49_875, 79_875, 109_875]);
    expect(slowdownLogs().map((line) => (JSON.parse(line) as { details: { intervalMs: number } }).details.intervalMs)).toEqual([
      10_500, 15_750, 23_625, 30_000,
    ]);
    expect(getHttpRequestMetrics()).toMatchObject({ attempts: 6, rateLimitedResponses: 6, endpointIntervalMs: { [detailsEndpoint]: 30_000 } });
  });

  it("does not slow down an endpoint without its own spacing", async () => {
    respond = () => tooManyRequests();
    await inSequence(() => fetchJson(votesUrl(1), { retries: 0 }), () => fetchJson(votesUrl(2), { retries: 0 }));
    expect(started.map((request) => request.at)).toEqual([0, 500]);
    expect(slowdownLogs()).toEqual([]);
  });

  it("reports the spacing of each paced endpoint the process requested", async () => {
    expect(getHttpRequestMetrics()).toEqual({ attempts: 0, retries: 0, rateLimitedResponses: 0, endpointIntervalMs: {} });
    await inSequence(() => fetchJson(votesUrl(1)));
    expect(getHttpRequestMetrics().endpointIntervalMs).toEqual({});
    await inSequence(() => fetchJson(detailsUrl(1)));
    expect(getHttpRequestMetrics()).toEqual({ attempts: 2, retries: 0, rateLimitedResponses: 0, endpointIntervalMs: { [detailsEndpoint]: 7_000 } });
  });
});
