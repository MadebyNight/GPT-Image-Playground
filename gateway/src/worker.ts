import type { AssetStore } from './assets.js';
import type { GatewayDatabase } from './db.js';
import { AppError } from './errors.js';
import type { ExecutionEvents } from './events.js';
import type { ImageExecutor } from './executor.js';
import { isToolAgentPlanV3, requireImageGeneration } from './plan.js';
import type { ExecutionActionView, ExecutionView, StoredAsset } from './types.js';

export class ExecutionWorker {
  private active = 0;
  private scheduled = false;
  private stopped = false;
  private shuttingDown = false;
  private readonly controllers = new Map<string, AbortController>();
  private readonly idleWaiters: Array<() => void> = [];

  constructor(
    private readonly db: GatewayDatabase,
    private readonly assets: AssetStore,
    private readonly executor: ImageExecutor,
    private readonly events: ExecutionEvents,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.shuttingDown = true;
    for (const controller of this.controllers.values()) controller.abort();
    if (this.active === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  notify(): void {
    this.schedule();
  }

  abort(executionId: string): void {
    this.controllers.get(executionId)?.abort();
  }

  private schedule(): void {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.stopped) return;
    while (!this.stopped) {
      const execution = this.db.claimNextExecution();
      if (!execution) break;
      this.active += 1;
      this.events.emitState(execution);
      void this.run(execution.id).finally(() => {
        this.active -= 1;
        if (this.active === 0) this.idleWaiters.splice(0).forEach((resolve) => resolve());
        this.schedule();
      });
    }
  }

  private async run(executionId: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(executionId, controller);
    try {
      const execution = this.db.getExecutionForWorker(executionId);
      if (this.db.isCancellationRequested(executionId)) {
        const cancelled = this.db.finishExecution(executionId, 'cancelled');
        this.events.emitState(cancelled);
        return;
      }
      const plan = this.db.getPlanForWorker(execution.planId);
      if (isToolAgentPlanV3(plan)) {
        await this.runV3(execution, controller);
      } else {
        await this.runLegacy(execution, controller);
      }
    } catch (error) {
      if (this.shuttingDown) {
        const shutdownError = {
          code: 'gateway_shutdown',
          message: 'Gateway 在上游调用期间关闭，任务不会自动重试',
        };
        const failedAction = this.db.failExecutingActionUnknown(executionId, shutdownError);
        if (failedAction) this.events.emitAction('action.failed_unknown', failedAction);
        const unknown = this.db.finishExecution(executionId, 'failed_unknown', shutdownError);
        this.events.emitState(unknown);
        return;
      }
      const cancelled = this.db.isCancellationRequested(executionId) || (error instanceof AppError && error.code === 'execution_cancelled');
      const final = cancelled
        ? this.db.finishExecution(executionId, 'cancelled')
        : this.db.finishExecution(executionId, 'failed', {
          code: error instanceof AppError ? error.code : 'execution_failed',
          message: error instanceof AppError ? error.message : '执行失败',
        });
      this.events.emitState(final);
    } finally {
      this.controllers.delete(executionId);
    }
  }

  private async runLegacy(execution: ExecutionView, controller: AbortController): Promise<void> {
    const generation = requireImageGeneration(this.db.getPlanForWorker(execution.planId));
    const inputs = this.db.getPlanAssets(execution.planId);
    const sessionId = this.db.getExecutionSessionId(execution.id);
    const buffers = await this.executor.executeGeneration({ generation, assets: inputs, signal: controller.signal });
    if (this.db.isCancellationRequested(execution.id)) {
      const cancelled = this.db.finishExecution(execution.id, 'cancelled');
      this.events.emitState(cancelled);
      return;
    }

    const generatedAssets = await this.storeGenerationOutputs(
      buffers,
      sessionId,
      execution.planId,
      execution.id,
      generation.outputFormat,
      generation.outputCompression,
    );
    this.db.insertOutputAssets(generatedAssets);
    const current = this.db.getExecutionForWorker(execution.id);
    for (const asset of current.outputAssets) this.events.emitAsset(execution.id, asset);
    const completed = this.db.finishExecution(execution.id, 'completed');
    this.events.emitState(completed);
  }

  private async runV3(execution: ExecutionView, controller: AbortController): Promise<void> {
    while (true) {
      if (this.db.isCancellationRequested(execution.id)) {
        const cancelled = this.db.finishExecution(execution.id, 'cancelled');
        this.events.emitState(cancelled);
        return;
      }

      const action = this.db.claimNextAction(execution.id);
      if (!action) {
        const current = this.db.getExecutionForWorker(execution.id);
        if (current.status === 'completed') {
          for (const asset of current.outputAssets) this.events.emitAsset(execution.id, asset);
          this.events.emitState(current);
          return;
        }
        if (['failed', 'cancelled', 'failed_unknown'].includes(current.status)) {
          this.events.emitState(current);
          return;
        }
        throw new AppError(500, 'action_chain_incomplete', 'v3 action 链未能推进到终态');
      }

      this.events.emitAction('action.started', action);
      try {
        this.assertActionCanContinue(controller.signal);
        const outputAssetIds = await this.executeV3Action(execution, action, controller.signal);
        this.assertActionCanContinue(controller.signal);
        if (this.db.isCancellationRequested(execution.id)) {
          const cancelled = this.db.cancelAction(action.id);
          this.events.emitAction('action.cancelled', cancelled);
          this.events.emitState(this.db.getExecutionForWorker(execution.id));
          return;
        }
        const completed = this.db.completeAction(action.id, outputAssetIds);
        this.events.emitAction('action.completed', completed);
        if (action.normalizedParams.type === 'metadata.assert') {
          const final = this.db.getExecutionForWorker(execution.id);
          if (final.status !== 'completed') {
            throw new AppError(500, 'action_chain_incomplete', 'metadata.assert 完成后执行未进入成功状态');
          }
          for (const asset of final.outputAssets) this.events.emitAsset(execution.id, asset);
          this.events.emitState(final);
          return;
        }
      } catch (error) {
        if (this.shuttingDown) throw error;
        if (this.db.isCancellationRequested(execution.id) || (error instanceof AppError && error.code === 'execution_cancelled')) {
          const cancelled = this.db.cancelAction(action.id);
          this.events.emitAction('action.cancelled', cancelled);
          this.events.emitState(this.db.getExecutionForWorker(execution.id));
          return;
        }
        const failed = this.db.failAction(action.id, {
          code: error instanceof AppError ? error.code : 'action_failed',
          message: error instanceof AppError ? error.message : 'action 执行失败',
        });
        this.events.emitAction('action.failed', failed);
        this.events.emitState(this.db.getExecutionForWorker(execution.id));
        return;
      }
    }
  }

  private async executeV3Action(
    execution: ExecutionView,
    action: ExecutionActionView,
    signal: AbortSignal,
  ): Promise<string[]> {
    const normalized = action.normalizedParams;
    const sessionId = this.db.getExecutionSessionId(execution.id);
    if (normalized.type === 'image.generate' || normalized.type === 'image.edit') {
      const inputs = action.inputAssets.map((asset) => this.db.getAsset(asset.id, sessionId));
      const buffers = await this.executor.executeGeneration({ generation: normalized.generation, assets: inputs, signal });
      const outputs = await this.storeGenerationOutputs(
        buffers,
        sessionId,
        execution.planId,
        execution.id,
        normalized.generation.outputFormat,
        normalized.generation.outputCompression,
      );
      this.db.insertOutputAssets(outputs);
      return outputs.map((asset) => asset.id);
    }

    const input = action.inputAssets[0];
    if (!input) throw new AppError(409, 'action_input_unavailable', 'action 缺少可用输入产物');
    const inputAsset = this.db.getAsset(input.id, sessionId);
    if (normalized.type === 'image.transform') {
      const output = await this.assets.transform(inputAsset, {
        sessionId,
        planId: execution.planId,
        executionId: execution.id,
      }, normalized.transform);
      try {
        this.db.insertOutputAssets([output]);
      } catch (error) {
        await this.assets.remove(output);
        throw error;
      }
      return [output.id];
    }

    await this.assets.assertMetadata(inputAsset, normalized.expected);
    return [inputAsset.id];
  }

  private assertActionCanContinue(signal: AbortSignal): void {
    if (this.shuttingDown || signal.aborted) {
      throw new AppError(499, 'execution_cancelled', '执行已取消');
    }
  }

  private async storeGenerationOutputs(
    buffers: Buffer[],
    sessionId: string,
    planId: string,
    executionId: string,
    outputFormat: 'png' | 'jpeg' | 'webp',
    outputCompression: number | null,
  ): Promise<StoredAsset[]> {
    const generatedAssets: StoredAsset[] = [];
    try {
      for (const buffer of buffers) {
        generatedAssets.push(await this.assets.storeGenerated(
          buffer,
          sessionId,
          planId,
          executionId,
          outputFormat,
          outputCompression,
        ));
      }
      return generatedAssets;
    } catch (error) {
      await Promise.all(generatedAssets.map((asset) => this.assets.remove(asset)));
      throw error;
    }
  }
}
