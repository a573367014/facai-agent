import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StoredAgentEvent } from "./agent-store.js";

export interface AgentEventLogger {
  log(event: StoredAgentEvent): void;
}

export class JsonlAgentEventLogger implements AgentEventLogger {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  log(event: StoredAgentEvent): void {
    const logRecord = {
      time: event.createdAt,
      kind: "agent_event",
      eventType: event.event.type,
      runId: event.runId,
      messageId: event.messageId,
      event: event.event
    };

    appendFileSync(this.filePath, `${JSON.stringify(logRecord)}\n`, "utf8");
  }
}
