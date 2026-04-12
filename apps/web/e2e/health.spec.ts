import { test, expect } from "@playwright/test";

test.describe("health endpoints", () => {
  test("GET /health returns 200 with structured body", async ({ request }) => {
    const response = await request.get("/health");
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(typeof body.activeJobs).toBe("number");
    expect(typeof body.projects).toBe("number");
  });

  test("GET /ready returns 200 when server is ready", async ({ request }) => {
    const response = await request.get("/ready");
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.ready).toBe(true);
  });
});
