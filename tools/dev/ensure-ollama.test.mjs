import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isLocalOllamaBaseUrl,
  resolveOllamaConfig
} from "./ensure-ollama.mjs";

describe("ensure-ollama", () => {
  it("reads Ollama embedding config from env file content", () => {
    const env = {
      EMBEDDING_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "http://127.0.0.1:11555",
      OLLAMA_EMBEDDING_MODEL: "nomic-embed-text"
    };

    assert.deepEqual(resolveOllamaConfig({ env }), {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11555",
      model: "nomic-embed-text"
    });
  });

  it("defaults to skipping Ollama when embedding provider is not local", () => {
    assert.deepEqual(resolveOllamaConfig({ env: {} }), {
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434",
      model: "embeddinggemma"
    });
  });

  it("only auto-starts local Ollama endpoints", () => {
    assert.equal(isLocalOllamaBaseUrl("http://localhost:11434"), true);
    assert.equal(isLocalOllamaBaseUrl("http://127.0.0.1:11434"), true);
    assert.equal(isLocalOllamaBaseUrl("http://[::1]:11434"), true);
    assert.equal(isLocalOllamaBaseUrl("https://ollama.example.com"), false);
    assert.equal(isLocalOllamaBaseUrl("not-a-url"), false);
  });

  it("wires Ollama preparation into the root dev script", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const startDevScript = readFileSync(new URL("./start-dev.mjs", import.meta.url), "utf8");

    assert.equal(packageJson.scripts.dev, "node tools/dev/start-dev.mjs");
    assert.match(startDevScript, /ensure-ollama\.mjs/);
    assert.match(startDevScript, /docker.*compose.*redis.*postgres.*minio/);
  });
});
