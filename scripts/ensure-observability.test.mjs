import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveGrafanaPort } from "./ensure-observability.mjs";

describe("ensure-observability", () => {
  it("defaults Grafana to 3001 so local development does not occupy the common 3000 port", () => {
    assert.equal(resolveGrafanaPort({ env: {}, envFile: "" }), 3001);
  });

  it("lets GRAFANA_PORT override the default from env or .env content", () => {
    assert.equal(resolveGrafanaPort({ env: {}, envFile: "GRAFANA_PORT=3300\n" }), 3300);
    assert.equal(resolveGrafanaPort({ env: { GRAFANA_PORT: "3400" }, envFile: "GRAFANA_PORT=3300\n" }), 3400);
  });
});
