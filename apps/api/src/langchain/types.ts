export interface RuntimeContext {
  messageId?: string;
  sessionId?: string;
  signal?: AbortSignal;
}
