import { accessSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./ensure-redis.mjs";

const defaultProvider = "openai-compatible";
const defaultOllamaBaseUrl = "http://localhost:11434";
const defaultOllamaModel = "embeddinggemma";
const defaultOllamaDir = join(process.env.HOME ?? process.cwd(), ".local", "var", "ollama");

function normalizeBaseUrl(baseUrl) {
  return (baseUrl || defaultOllamaBaseUrl).trim().replace(/\/+$/, "");
}

export function resolveOllamaConfig({ env = process.env } = {}) {
  return {
    provider: env.EMBEDDING_PROVIDER || defaultProvider,
    baseUrl: normalizeBaseUrl(env.OLLAMA_BASE_URL || defaultOllamaBaseUrl),
    model: env.OLLAMA_EMBEDDING_MODEL || defaultOllamaModel
  };
}

export function isLocalOllamaBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      localHosts.has(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function readEnvFile(path) {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function loadDevEnv(cwd = process.cwd()) {
  const rootEnv = readEnvFile(resolve(cwd, ".env"));
  const apiEnv = readEnvFile(resolve(cwd, "apps", "api", ".env"));

  // Keep the same precedence as apps/api/src/server.ts: shell > root .env > apps/api/.env.
  return {
    ...apiEnv,
    ...rootEnv,
    ...process.env
  };
}

function findExecutable(command) {
  const paths = [
    ...(process.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ].filter(Boolean);

  for (const dir of paths) {
    const candidate = join(dir, command);

    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // keep searching
    }
  }

  return undefined;
}

function installOllama() {
  const existingOllama = findExecutable("ollama");

  if (existingOllama) {
    return existingOllama;
  }

  const brew = findExecutable("brew");

  if (!brew) {
    throw new Error("未找到 Ollama，也未找到 Homebrew，无法自动安装。请先安装 Homebrew 或手动安装 Ollama。");
  }

  console.log("[ollama] 未找到 Ollama，正在通过 Homebrew 安装：brew install ollama");
  const result = spawnSync(brew, ["install", "ollama"], { stdio: "inherit" });

  if (result.status !== 0) {
    throw new Error("Homebrew 安装 Ollama 失败。");
  }

  const installedOllama = findExecutable("ollama");

  if (!installedOllama) {
    throw new Error("Ollama 已尝试安装，但仍不在 PATH 中。");
  }

  return installedOllama;
}

function endpoint(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function pingOllama(baseUrl) {
  try {
    const response = await fetchWithTimeout(endpoint(baseUrl, "/api/version"));
    return response.ok;
  } catch {
    return false;
  }
}

async function hasOllamaModel(baseUrl, model) {
  try {
    const response = await fetchWithTimeout(endpoint(baseUrl, "/api/show"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      timeoutMs: 5000
    });

    return response.ok;
  } catch {
    return false;
  }
}

function getOllamaServeHost(baseUrl) {
  const url = new URL(baseUrl);
  return url.host || "localhost:11434";
}

function isDefaultLocalOllamaPort(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return isLocalOllamaBaseUrl(baseUrl) && (url.port || "11434") === "11434";
  } catch {
    return false;
  }
}

function startOllama(baseUrl, ollamaCli) {
  const brew = findExecutable("brew");

  if (brew && isDefaultLocalOllamaPort(baseUrl)) {
    const result = spawnSync(brew, ["services", "start", "ollama"], {
      encoding: "utf8"
    });

    if (result.status === 0) {
      return;
    }

    console.log("[ollama] Homebrew service 启动失败，改用当前项目后台进程启动。");
  }

  mkdirSync(defaultOllamaDir, { recursive: true });

  const logFile = openSync(join(defaultOllamaDir, "ollama.log"), "a");
  const child = spawn(ollamaCli, ["serve"], {
    detached: true,
    env: {
      ...process.env,
      OLLAMA_HOST: getOllamaServeHost(baseUrl)
    },
    stdio: ["ignore", logFile, logFile]
  });

  child.unref();
}

async function waitForOllama(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await pingOllama(baseUrl)) {
      return true;
    }

    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 500));
  }

  return false;
}

function pullOllamaModel(model, ollamaCli) {
  const result = spawnSync(ollamaCli, ["pull", model], { stdio: "inherit" });

  if (result.status !== 0) {
    throw new Error(`Ollama 模型拉取失败：${model}`);
  }
}

export async function ensureOllama({ cwd = process.cwd() } = {}) {
  const config = resolveOllamaConfig({ env: loadDevEnv(cwd) });

  if (config.provider !== "ollama") {
    console.log(`[ollama] EMBEDDING_PROVIDER=${config.provider}，跳过本地 Ollama 检查。`);
    return;
  }

  if (!isLocalOllamaBaseUrl(config.baseUrl)) {
    if (await pingOllama(config.baseUrl)) {
      console.log(`[ollama] 已连接：${config.baseUrl}`);
      return;
    }

    throw new Error(`Ollama 未连接，且 OLLAMA_BASE_URL=${config.baseUrl} 不是本机地址，无法自动启动。`);
  }

  let ollamaCli = findExecutable("ollama");

  if (!(await pingOllama(config.baseUrl))) {
    ollamaCli = installOllama();
    console.log(`[ollama] 未检测到本机 Ollama 服务，正在自动启动：${config.baseUrl}`);
    startOllama(config.baseUrl, ollamaCli);

    if (!(await waitForOllama(config.baseUrl))) {
      throw new Error("Ollama 已尝试启动，但 /api/version 未通过，请检查 brew services list 或 ~/.local/var/ollama/ollama.log。");
    }
  }

  console.log(`[ollama] 已连接：${config.baseUrl}`);

  if (await hasOllamaModel(config.baseUrl, config.model)) {
    console.log(`[ollama] 模型已就绪：${config.model}`);
    return;
  }

  ollamaCli ??= installOllama();
  console.log(`[ollama] 未检测到模型 ${config.model}，正在拉取。首次下载可能需要几分钟。`);
  pullOllamaModel(config.model, ollamaCli);

  if (!(await hasOllamaModel(config.baseUrl, config.model))) {
    throw new Error(`模型已尝试拉取，但 Ollama 仍无法读取：${config.model}`);
  }

  console.log(`[ollama] 模型已就绪：${config.model}`);
}

const currentFile = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  ensureOllama().catch((error) => {
    console.error(`[ollama] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
