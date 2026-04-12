import { describe, expect, it } from "vitest";
import { createMetricsEndpoint } from "./metrics.js";

describe("metrics endpoint", () => {
  it("returns Prometheus text format with WAL depth gauge", async () => {
    const fakeWal = { getDepth: () => 42 };
    const metricsApi = createMetricsEndpoint(() => fakeWal as never);

    const res = await metricsApi.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const body = await res.text();
    expect(body).toContain("ironlore_wal_depth 42");
    expect(body).toContain("ironlore_ws_connections 0");
    expect(body).toContain("# TYPE ironlore_wal_depth gauge");
  });

  it("returns 0 WAL depth when wal is null", async () => {
    const metricsApi = createMetricsEndpoint(() => null);

    const res = await metricsApi.request("/");
    const body = await res.text();
    expect(body).toContain("ironlore_wal_depth 0");
  });
});
