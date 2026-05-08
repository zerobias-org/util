import { LoggerEngine } from '@zerobias-org/logger';

export const logger: LoggerEngine = LoggerEngine.root().get('SecretsManager');

/** Coerce an unknown thrown value to a printable string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const sleep = async function (min: number, max: number) {
  const minCalc = Math.ceil(min);
  const maxCalc = Math.floor(max);
  const sleepTime = Math.floor(Math.random() * (maxCalc - minCalc + 1)) + minCalc;
   
  return new Promise((resolve) => setTimeout(resolve, sleepTime));
};

export class Semaphore {
  private permits: number;

  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }

    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    this.permits += 1;
    if (this.waitQueue.length > 0) {
      const resolve = this.waitQueue.shift()!;
      this.permits -= 1;
      resolve();
    }
  }
}
