export interface RunningRunState {
  runId: string;
}

export type RunningRunsBySession = Record<string, RunningRunState>;

type RunRegistryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const activeRunIdKey = "agent.activeRunId";
const runningRunsBySessionKey = "agent.runningRunsBySession";

function getDefaultStorage(): RunRegistryStorage {
  return localStorage;
}

export function readActiveRunId(storage: RunRegistryStorage = getDefaultStorage()) {
  return storage.getItem(activeRunIdKey);
}

export function writeActiveRunId(
  runId: string,
  storage: RunRegistryStorage = getDefaultStorage()
) {
  storage.setItem(activeRunIdKey, runId);
}

export function clearActiveRunId(storage: RunRegistryStorage = getDefaultStorage()) {
  storage.removeItem(activeRunIdKey);
}

export function readRunningRunsBySession(
  storage: RunRegistryStorage = getDefaultStorage()
): RunningRunsBySession {
  // 这里记录“每个会话当前还在跑的 run”。
  // 用户切换会话或刷新页面后，前端可以用 runId 重新接上 SSE，而不是丢掉正在生成的回答。
  try {
    const rawValue = storage.getItem(runningRunsBySessionKey);

    if (!rawValue) {
      return {};
    }

    const parsedValue = JSON.parse(rawValue) as Record<string, unknown>;
    const runningRuns: RunningRunsBySession = {};

    for (const [sessionId, value] of Object.entries(parsedValue)) {
      if (!value || typeof value !== "object") {
        continue;
      }

      const candidate = value as Partial<RunningRunState>;

      if (typeof candidate.runId === "string") {
        runningRuns[sessionId] = {
          runId: candidate.runId
        };
      }
    }

    return runningRuns;
  } catch {
    return {};
  }
}

export function writeRunningRunsBySession(
  runningRuns: RunningRunsBySession,
  storage: RunRegistryStorage = getDefaultStorage()
) {
  if (Object.keys(runningRuns).length === 0) {
    storage.removeItem(runningRunsBySessionKey);
    return;
  }

  storage.setItem(runningRunsBySessionKey, JSON.stringify(runningRuns));
}

export function withRunningRun(
  runningRuns: RunningRunsBySession,
  sessionId: string,
  runId: string
): RunningRunsBySession {
  return {
    ...runningRuns,
    [sessionId]: { runId }
  };
}

export function withoutRunningRunByRunId(
  runningRuns: RunningRunsBySession,
  runId: string | undefined
): RunningRunsBySession {
  if (!runId) {
    return runningRuns;
  }

  const matchingEntry = Object.entries(runningRuns).find(
    ([, runningRun]) => runningRun.runId === runId
  );

  if (!matchingEntry) {
    return runningRuns;
  }

  return Object.fromEntries(
    Object.entries(runningRuns).filter(([, runningRun]) => runningRun.runId !== runId)
  );
}

export function withoutRunningRunForSession(
  runningRuns: RunningRunsBySession,
  sessionId: string
): RunningRunsBySession {
  if (!runningRuns[sessionId]) {
    return runningRuns;
  }

  return Object.fromEntries(
    Object.entries(runningRuns).filter(
      ([candidateSessionId]) => candidateSessionId !== sessionId
    )
  );
}
