import type { AssetStore } from './assets.js';
import type { GatewayDatabase } from './db.js';
import { AppError } from './errors.js';
import type { ExecutionEvents } from './events.js';
import type { ImageExecutor } from './executor.js';
import { requireImageGeneration } from './plan.js';

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
      const generation = requireImageGeneration(plan);
      const inputs = this.db.getPlanAssets(execution.planId);
      const sessionId = this.db.getExecutionSessionId(executionId);
      const buffers = await this.executor.execute({ plan, assets: inputs, signal: controller.signal });
      if (this.db.isCancellationRequested(executionId)) {
        const cancelled = this.db.finishExecution(executionId, 'cancelled');
        this.events.emitState(cancelled);
        return;
      }

      const generatedAssets = [];
      try {
        for (const buffer of buffers) {
          generatedAssets.push(await this.assets.storeGenerated(
            buffer, sessionId, execution.planId, executionId, generation.outputFormat,
            generation.outputCompression,
          ));
        }
        this.db.insertOutputAssets(generatedAssets);
      } catch (error) {
        await Promise.all(generatedAssets.map((asset) => this.assets.remove(asset)));
        throw error;
      }
      const current = this.db.getExecutionForWorker(executionId);
      for (const asset of current.outputAssets) this.events.emitAsset(executionId, asset);
      const completed = this.db.finishExecution(executionId, 'completed');
      this.events.emitState(completed);
    } catch (error) {
      if (this.shuttingDown) {
        const unknown = this.db.finishExecution(executionId, 'failed_unknown', {
          code: 'gateway_shutdown',
          message: 'Gateway 在上游调用期间关闭，任务不会自动重试',
        });
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
}
