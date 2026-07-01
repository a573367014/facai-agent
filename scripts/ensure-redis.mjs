import { accessSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultRedisUrl = "redis://localhost:6379";
const defaultRedisDir = join(process.env.HOME ?? process.cwd(), ".local", "var", "redis");

export function parseEnvFile(content) {
  const env = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalizedLine = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalizedLine.indexOf("=");

    if (equalsIndex === -1) {
      continue;
    }

    const key = normalizedLine.slice(0, equalsIndex).trim();
    let value = normalizedLine.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      env[key] = value;
    }
  }

  return env;
}

export function resolveRedisUrl({ env = process.env } = {}) {
  return env.REDIS_URL || defaultRedisUrl;
}

export function isAutoStartableRedisUrl(redisUrl) {
  try {
    const url = new URL(redisUrl);
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

    return (
      (url.protocol === "redis:" || url.protocol === "rediss:") &&
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

  // apps/api/src/server.ts 先加载根 .env，再加载 apps/api/.env，且 dotenv 默认不覆盖已有值。
  // 这里保持同样优先级：shell 环境变量最高，根 .env 高于 apps/api/.env。
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

function pingRedis(redisUrl, redisCli = findExecutable("redis-cli")) {
  if (!redisCli) {
    return false;
  }

  const result = spawnSync(redisCli, ["-u", redisUrl, "ping"], {
    encoding: "utf8",
    timeout: 3000
  });

  return result.status === 0 && result.stdout.trim() === "PONG";
}

function startRedis(redisUrl, redisServer = findExecutable("redis-server")) {
  if (!redisServer) {
    throw new Error("未找到 redis-server，请先安装 Redis，或把 redis-server 放进 PATH。");
  }

  const url = new URL(redisUrl);
  const port = url.port || "6379";

  mkdirSync(defaultRedisDir, { recursive: true });

  const result = spawnSync(
    redisServer,
    [
      "--daemonize",
      "yes",
      "--bind",
      "127.0.0.1",
      "--port",
      port,
      "--dir",
      defaultRedisDir,
      "--logfile",
      join(defaultRedisDir, "redis.log"),
      "--pidfile",
      join(defaultRedisDir, "redis.pid")
    ],
    {
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "redis-server 启动失败");
  }
}

async function waitForRedis(redisUrl) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (pingRedis(redisUrl)) {
      return true;
    }

    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 100));
  }

  return false;
}

export async function ensureRedis({ cwd = process.cwd() } = {}) {
  const redisUrl = resolveRedisUrl({ env: loadDevEnv(cwd) });

  if (pingRedis(redisUrl)) {
    console.log(`[redis] 已连接：${redisUrl}`);
    return;
  }

  if (!isAutoStartableRedisUrl(redisUrl)) {
    throw new Error(`Redis 未连接，且 REDIS_URL=${redisUrl} 不是无密码本机 Redis，无法自动启动。`);
  }

  console.log(`[redis] 未检测到本机 Redis，正在自动启动：${redisUrl}`);
  startRedis(redisUrl);

  if (!(await waitForRedis(redisUrl))) {
    throw new Error("Redis 已尝试启动，但 ping 未通过，请查看 ~/.local/var/redis/redis.log。");
  }

  console.log(`[redis] 已启动：${redisUrl}`);
}

const currentFile = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  ensureRedis().catch((error) => {
    console.error(`[redis] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
