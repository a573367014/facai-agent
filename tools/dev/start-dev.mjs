import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 执行失败（退出码 ${result.status ?? "unknown"}）`);
  }
}

function startApplicationProcesses() {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "concurrently",
      "-n",
      "api,web,worker",
      "-c",
      "cyan,magenta,yellow",
      "pnpm --filter @agent/api dev",
      "pnpm --filter @agent/web dev",
      "pnpm --filter @agent/api dev:worker"
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit"
    }
  );

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));

  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

async function main() {
  // 所有前置动作集中在这里，package.json 只保留一个可读的入口命令。
  run(process.execPath, ["tools/dev/ensure-ollama.mjs"]);
  run(process.execPath, ["tools/dev/ensure-observability.mjs"]);
  run("docker", ["compose", "up", "-d", "--wait", "redis", "postgres", "minio"]);
  run("pnpm", ["run", "db:migrate"]);

  if (process.argv.includes("--infra-only")) {
    console.log("[dev] 基础设施已就绪，未启动 API / Web / Worker。");
    return;
  }

  startApplicationProcesses();
}

main().catch((error) => {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
