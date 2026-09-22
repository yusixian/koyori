export interface AgentConnectionInput {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}
export interface AgentConnection {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
}
export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}
export type AgentMessageStatus = "complete" | "streaming" | "cancelled" | "failed" | "interrupted";
export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  status: AgentMessageStatus;
  usage: AgentUsage | null;
  error: string | null;
}
export interface AgentSession {
  id: string;
  connectionId: string;
  connectionName: string;
  model: string;
  title: string;
  createdAt: string;
  messages: AgentMessage[];
}
export interface AgentView {
  connection: AgentConnection | null;
  sessions: AgentSession[];
  selectedSessionId: string | null;
  runningSessionId: string | null;
  secureStorageAvailable: boolean | null;
  error: string | null;
}

export interface AgentProviderRequest {
  baseUrl: string;
  model: string;
  apiKey: string;
  messages: { role: "user" | "assistant"; content: string }[];
  signal: AbortSignal;
  onText(text: string): void;
  onUsage(usage: AgentUsage): void;
}
