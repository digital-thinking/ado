export type PhaseLoopSignal = "NEXT" | "STOP";

export type PhaseLoopWaitHandle = {
  id: number;
  promise: Promise<PhaseLoopSignal>;
};

export class PhaseLoopControl {
  private queuedNextCount = 0;
  private stopRequested = false;
  private nextWaiterId = 1;
  private readonly waiters = new Map<number, (signal: PhaseLoopSignal) => void>();

  requestNext(): boolean {
    if (this.stopRequested) {
      return false;
    }

    const firstWaiter = this.waiters.entries().next();
    if (!firstWaiter.done) {
      const [waiterId, resolve] = firstWaiter.value;
      this.waiters.delete(waiterId);
      resolve("NEXT");
      return true;
    }

    this.queuedNextCount += 1;
    return true;
  }

  requestStop(): void {
    if (this.stopRequested) {
      return;
    }

    this.stopRequested = true;
    for (const resolve of this.waiters.values()) {
      resolve("STOP");
    }
    this.waiters.clear();
  }

  isStopRequested(): boolean {
    return this.stopRequested;
  }

  waitForSignal(): PhaseLoopWaitHandle {
    if (this.stopRequested) {
      return {
        id: 0,
        promise: Promise.resolve("STOP"),
      };
    }

    if (this.queuedNextCount > 0) {
      this.queuedNextCount -= 1;
      return {
        id: 0,
        promise: Promise.resolve("NEXT"),
      };
    }

    const id = this.nextWaiterId;
    this.nextWaiterId += 1;
    const promise = new Promise<PhaseLoopSignal>((resolve) => {
      this.waiters.set(id, resolve);
    });

    return { id, promise };
  }

  cancelWait(id: number): void {
    if (id <= 0) {
      return;
    }

    this.waiters.delete(id);
  }
}
