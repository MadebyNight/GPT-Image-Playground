import { EventEmitter } from 'node:events';
import type { ExecutionStatus, ExecutionView } from './types.js';

export interface ExecutionStateEvent {
  executionId: string;
  planId: string;
  status: ExecutionStatus;
  updatedAt: string;
}

export interface AssetReadyEvent {
  executionId: string;
  asset: ExecutionView['outputAssets'][number];
}

export class ExecutionEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emitState(execution: ExecutionView): void {
    const event = execution.status === 'executing' ? 'execution.started' : `execution.${execution.status}`;
    try {
      this.emitter.emit(`execution:${execution.id}`, event, {
        executionId: execution.id,
        planId: execution.planId,
        status: execution.status,
        updatedAt: execution.updatedAt,
      } satisfies ExecutionStateEvent);
    } catch {
      // 事件订阅者不能改变确定性执行状态。
    }
  }

  emitAsset(executionId: string, asset: ExecutionView['outputAssets'][number]): void {
    try {
      this.emitter.emit(`execution:${executionId}`, 'asset.ready', { executionId, asset } satisfies AssetReadyEvent);
    } catch {
      // 事件订阅者不能改变确定性执行状态。
    }
  }

  subscribe(executionId: string, listener: (event: string, data: unknown) => void): () => void {
    const eventName = `execution:${executionId}`;
    this.emitter.on(eventName, listener);
    return () => this.emitter.off(eventName, listener);
  }
}
