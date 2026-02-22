import type { PhaseLoopControl } from "./phase-loop-control";

export type LoopAdvanceSignal = "NEXT" | "STOP";

export type WaitForManualAdvanceInput = {
  loopControl: PhaseLoopControl;
  nextTaskLabel: string;
  askLocal: () => Promise<LoopAdvanceSignal>;
  cancelLocal: () => void;
  onInfo?: (line: string) => void;
};

export async function waitForManualAdvance(
  input: WaitForManualAdvanceInput
): Promise<LoopAdvanceSignal> {
  if (input.loopControl.isStopRequested()) {
    return "STOP";
  }

  input.onInfo?.(
    `Manual mode: press Enter to start ${input.nextTaskLabel}, type 'stop' to halt (Telegram: /next or /stop).`
  );

  const waitHandle = input.loopControl.waitForSignal();
  const remotePromise = waitHandle.promise.then((signal) => ({
    source: "remote" as const,
    signal,
  }));
  const localPromise = input.askLocal().then((signal) => ({
    source: "local" as const,
    signal,
  }));
  const outcome = await Promise.race([remotePromise, localPromise]);

  if (outcome.source === "remote") {
    input.cancelLocal();
  } else {
    input.loopControl.cancelWait(waitHandle.id);
  }

  return outcome.signal;
}

export type WaitForAutoAdvanceInput = {
  loopControl: PhaseLoopControl;
  countdownSeconds: number;
  nextTaskLabel: string;
  onInfo?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export async function waitForAutoAdvance(
  input: WaitForAutoAdvanceInput
): Promise<LoopAdvanceSignal> {
  if (input.loopControl.isStopRequested()) {
    return "STOP";
  }

  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  input.onInfo?.(
    `Auto mode: starting ${input.nextTaskLabel} in ${input.countdownSeconds}s (Telegram: /next to start now, /stop to halt).`
  );

  for (let remaining = input.countdownSeconds; remaining > 0; remaining -= 1) {
    if (input.loopControl.isStopRequested()) {
      return "STOP";
    }

    const waitHandle = input.loopControl.waitForSignal();
    const tickPromise = sleep(1_000).then(() => "TICK" as const);
    const outcome = await Promise.race([waitHandle.promise, tickPromise]);

    if (outcome === "STOP") {
      return "STOP";
    }
    if (outcome === "NEXT") {
      return "NEXT";
    }

    input.loopControl.cancelWait(waitHandle.id);
    const nextRemaining = remaining - 1;
    if (nextRemaining > 0) {
      input.onInfo?.(`Auto mode: ${nextRemaining}s remaining before ${input.nextTaskLabel}.`);
    }
  }

  return "NEXT";
}
