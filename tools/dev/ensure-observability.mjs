import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./ensure-redis.mjs";

const lgtmContainerName = "agent-lgtm-1";
const otlpPort = 4318;
const defaultGrafanaPort = 3001;

const dockerExtraPaths = [
  "/Applications/Docker.app/Contents/Resources/bin",
  "/usr/local/bin"
];

function dockerEnv() {
  const path = [process.env.PATH, ...dockerExtraPaths].filter(Boolean).join(":");
  return { ...process.env, PATH: path };
}

function readLocalEnvFile(cwd) {
  try {
    return readFileSync(join(cwd, ".env"), "utf8");
  } catch {
    return "";
  }
}

export function resolveGrafanaPort({ cwd = process.cwd(), env = process.env, envFile } = {}) {
  const fileEnv = parseEnvFile(envFile ?? readLocalEnvFile(cwd));
  const rawPort = env.GRAFANA_PORT ?? fileEnv.GRAFANA_PORT;
  const parsedPort = Number(rawPort ?? defaultGrafanaPort);

  if (Number.isInteger(parsedPort) && parsedPort > 0) {
    return parsedPort;
  }

  return defaultGrafanaPort;
}

function findDocker() {
  const result = spawnSync("which", ["docker"], { encoding: "utf8", timeout: 3000, env: dockerEnv() });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim();
}

function isLgtmRunning() {
  const result = spawnSync(
    "docker",
    ["ps", "--filter", `name=${lgtmContainerName}`, "--filter", "status=running", "--format", "{{.Names}}"],
    { encoding: "utf8", timeout: 5000, env: dockerEnv() }
  );
  return result.status === 0 && result.stdout.trim().includes(lgtmContainerName);
}

function startLgtm(cwd) {
  const result = spawnSync("docker", ["compose", "up", "-d", "lgtm"], {
    encoding: "utf8",
    timeout: 600000,
    cwd,
    env: dockerEnv()
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "docker compose up 失败");
  }
}

async function waitForGrafana(grafanaPort) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://localhost:${grafanaPort}/api/health`], {
      encoding: "utf8",
      timeout: 2000
    });

    if (result.status === 0 && result.stdout.trim() === "200") {
      return true;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  return false;
}

export async function ensureObservability({ cwd = process.cwd() } = {}) {
  const grafanaPort = resolveGrafanaPort({ cwd });
  const docker = findDocker();

  if (!docker) {
    console.warn("[observability] 未检测到 docker，跳过 lgtm 启动。trace/metrics/logs 将无法收集。");
    return;
  }

  if (isLgtmRunning()) {
    console.log(`[observability] lgtm 已在运行：http://localhost:${grafanaPort}`);
    return;
  }

  console.log("[observability] 正在启动 grafana/otel-lgtm...");
  startLgtm(resolve(cwd));

  if (!(await waitForGrafana(grafanaPort))) {
    console.warn(`[observability] lgtm 容器已启动，但 Grafana 端口 ${grafanaPort} 未就绪，可能需要等待。`);
    return;
  }

  console.log(`[observability] 已启动：Grafana http://localhost:${grafanaPort} | OTLP ${otlpPort}`);
}

const currentFile = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  ensureObservability().catch((error) => {
    console.error(`[observability] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
