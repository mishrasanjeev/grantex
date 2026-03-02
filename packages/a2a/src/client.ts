/**
 * A2A client with Grantex grant token authentication.
 *
 * Wraps A2A JSON-RPC 2.0 calls (tasks/send, tasks/get, tasks/cancel)
 * with Bearer grant token authorization headers.
 */

import { decodeJwtPayload, isTokenExpired } from './_jwt.js';
import type {
  A2AGrantexClientOptions,
  A2ATask,
  JsonRpcRequest,
  JsonRpcResponse,
  TaskSendParams,
  TaskGetParams,
  TaskCancelParams,
} from './types.js';

export class A2AGrantexClient {
  private readonly agentUrl: string;
  private readonly grantToken: string;
  private readonly requiredScope?: string;
  private requestId = 0;

  constructor(options: A2AGrantexClientOptions) {
    this.agentUrl = options.agentUrl.replace(/\/$/, '');
    this.grantToken = options.grantToken;
    this.requiredScope = options.requiredScope;
    this.validateToken();
  }

  private validateToken(): void {
    const payload = decodeJwtPayload(this.grantToken);
    if (isTokenExpired(payload)) {
      throw new Error('Grant token is expired');
    }
    if (this.requiredScope && payload.scp) {
      if (!payload.scp.includes(this.requiredScope)) {
        throw new Error(`Grant token missing required scope: ${this.requiredScope}`);
      }
    }
  }

  private async rpc(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const response = await fetch(this.agentUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.grantToken}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`A2A request failed: ${response.status} ${response.statusText}`);
    }

    return await response.json() as JsonRpcResponse;
  }

  /**
   * Send a task to the remote A2A agent.
   */
  async sendTask(params: TaskSendParams): Promise<A2ATask> {
    const response = await this.rpc('tasks/send', params as unknown as Record<string, unknown>);
    if (response.error) {
      throw new Error(`A2A error ${response.error.code}: ${response.error.message}`);
    }
    return response.result as A2ATask;
  }

  /**
   * Get the current state of a task.
   */
  async getTask(params: TaskGetParams): Promise<A2ATask> {
    const response = await this.rpc('tasks/get', params as unknown as Record<string, unknown>);
    if (response.error) {
      throw new Error(`A2A error ${response.error.code}: ${response.error.message}`);
    }
    return response.result as A2ATask;
  }

  /**
   * Cancel a running task.
   */
  async cancelTask(params: TaskCancelParams): Promise<A2ATask> {
    const response = await this.rpc('tasks/cancel', params as unknown as Record<string, unknown>);
    if (response.error) {
      throw new Error(`A2A error ${response.error.code}: ${response.error.message}`);
    }
    return response.result as A2ATask;
  }

  /**
   * Get the decoded grant token payload (without verification).
   */
  getTokenInfo() {
    return decodeJwtPayload(this.grantToken);
  }
}
