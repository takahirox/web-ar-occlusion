import assert from "node:assert/strict";
import test from "node:test";

import type { DepthFrame, DepthProvider } from "../src/contracts.ts";
import {
  LatestDepthScheduler,
  type CapturedDepthFrame,
  type LatestDepthSchedulerOutcome,
} from "../src/scheduler.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface FakeVideoFrame {
  closeCount: number;
  close(): void;
}

interface ProviderCall {
  readonly frame: VideoFrame;
  readonly result: Deferred<unknown>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeVideoFrame(): FakeVideoFrame {
  return {
    closeCount: 0,
    close() {
      this.closeCount += 1;
    },
  };
}

function capture(
  sourceFrameId: string,
  captureTimestamp: number,
  frame = fakeVideoFrame(),
): CapturedDepthFrame & { frame: VideoFrame & FakeVideoFrame } {
  return {
    frame: frame as VideoFrame & FakeVideoFrame,
    sourceFrameId,
    captureTimestamp,
  };
}

function depthFrame(
  sourceFrameId: string,
  captureTimestamp: number,
): DepthFrame {
  return {
    width: 2,
    height: 2,
    depth: { destroy() {} },
    confidence: { destroy() {} },
    captureTimestamp,
    sourceFrameId,
    uvTransform: new Float32Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]),
    representation: "linear-z",
    scale: "metric",
    unit: "meter",
  } as unknown as DepthFrame;
}

function controlledProvider(calls: ProviderCall[]): DepthProvider {
  return {
    infer(frame: VideoFrame): Promise<DepthFrame> {
      const result = deferred<unknown>();
      calls.push({ frame, result });
      return result.promise as Promise<DepthFrame>;
    },
  } as DepthProvider;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function discardedReasons(
  outcomes: readonly LatestDepthSchedulerOutcome[],
): string[] {
  return outcomes.flatMap((outcome) =>
    outcome.type === "discarded" ? [outcome.reason] : [],
  );
}

test("keeps one inference in flight and only the latest pending capture", async () => {
  const calls: ProviderCall[] = [];
  const outcomes: LatestDepthSchedulerOutcome[] = [];
  const publishCallCounts: number[] = [];
  const scheduler = new LatestDepthScheduler(controlledProvider(calls), {
    onOutcome(outcome) {
      outcomes.push(outcome);
      if (outcome.type === "published") publishCallCounts.push(calls.length);
    },
  });
  const active = capture("active", 1);
  const replaced = capture("replaced", 2);
  const latest = capture("latest", 3);

  scheduler.submit(active);
  scheduler.submit(replaced);
  scheduler.submit(latest);

  assert.equal(calls.length, 1);
  assert.deepEqual(scheduler.state, {
    status: "running",
    generation: 0,
    inferenceInFlight: true,
    hasPendingCapture: true,
  });
  assert.equal(replaced.frame.closeCount, 1);
  assert.equal(latest.frame.closeCount, 0);
  assert.deepEqual(discardedReasons(outcomes), ["superseded"]);

  calls[0]!.result.resolve(depthFrame("active", 1));
  await flush();

  assert.equal(scheduler.latestPublishedFrame?.sourceFrameId, "active");
  assert.deepEqual(publishCallCounts, [1]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.frame, latest.frame);
  assert.equal(active.frame.closeCount, 1);

  calls[1]!.result.resolve(depthFrame("latest", 3));
  await flush();

  assert.equal(scheduler.latestPublishedFrame?.sourceFrameId, "latest");
  assert.equal(latest.frame.closeCount, 1);
  assert.equal(scheduler.state.inferenceInFlight, false);
  assert.equal(scheduler.state.hasPendingCapture, false);
});

test("invalid active results preserve latest publication and pending work continues", async () => {
  const calls: ProviderCall[] = [];
  const outcomes: LatestDepthSchedulerOutcome[] = [];
  const scheduler = new LatestDepthScheduler(controlledProvider(calls), {
    onOutcome: (outcome) => outcomes.push(outcome),
  });

  const seed = capture("seed", 1);
  scheduler.submit(seed);
  calls[0]!.result.resolve(depthFrame("seed", 1));
  await flush();
  const seedResult = scheduler.latestPublishedFrame;

  const malformed = capture("malformed", 2);
  const afterMalformed = capture("after-malformed", 3);
  scheduler.submit(malformed);
  scheduler.submit(afterMalformed);
  calls[1]!.result.resolve({});
  await flush();
  assert.equal(scheduler.latestPublishedFrame, seedResult);
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.frame, afterMalformed.frame);
  calls[2]!.result.resolve(depthFrame("after-malformed", 3));
  await flush();

  const beforeMismatch = scheduler.latestPublishedFrame;
  const mismatched = capture("expected", 4);
  const afterMismatch = capture("after-mismatch", 5);
  scheduler.submit(mismatched);
  scheduler.submit(afterMismatch);
  calls[3]!.result.resolve(depthFrame("different", 4));
  await flush();
  assert.equal(scheduler.latestPublishedFrame, beforeMismatch);
  assert.equal(calls.length, 5);
  assert.equal(calls[4]!.frame, afterMismatch.frame);
  calls[4]!.result.resolve(depthFrame("after-mismatch", 5));
  await flush();

  const beforeOlder = scheduler.latestPublishedFrame;
  const older = capture("older", 4);
  const afterOlder = capture("after-older", 6);
  scheduler.submit(older);
  scheduler.submit(afterOlder);
  calls[5]!.result.resolve(depthFrame("older", 4));
  await flush();
  assert.equal(scheduler.latestPublishedFrame, beforeOlder);
  assert.equal(calls.length, 7);
  assert.equal(calls[6]!.frame, afterOlder.frame);
  calls[6]!.result.resolve(depthFrame("after-older", 6));
  await flush();

  const beforeRejection = scheduler.latestPublishedFrame;
  const rejected = capture("rejected", 7);
  const afterRejection = capture("after-rejection", 8);
  scheduler.submit(rejected);
  scheduler.submit(afterRejection);
  const failure = new Error("inference failed");
  calls[7]!.result.reject(failure);
  await flush();
  assert.equal(scheduler.latestPublishedFrame, beforeRejection);
  assert.equal(calls.length, 9);
  assert.equal(calls[8]!.frame, afterRejection.frame);
  calls[8]!.result.resolve(depthFrame("after-rejection", 8));
  await flush();

  assert.equal(scheduler.latestPublishedFrame?.sourceFrameId, "after-rejection");
  assert.deepEqual(discardedReasons(outcomes), [
    "malformed",
    "mismatched",
    "older",
    "rejected",
  ]);
  assert.equal(seed.frame.closeCount, 1);
  assert.equal(malformed.frame.closeCount, 1);
  assert.equal(mismatched.frame.closeCount, 1);
  assert.equal(older.frame.closeCount, 1);
  assert.equal(rejected.frame.closeCount, 1);
});

test("rejects results whose source association does not exactly match", async (t) => {
  const cases = [
    { name: "source frame id", resultSourceFrameId: "other", resultTimestamp: 10 },
    { name: "capture timestamp", resultSourceFrameId: "expected", resultTimestamp: 11 },
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const calls: ProviderCall[] = [];
      const outcomes: LatestDepthSchedulerOutcome[] = [];
      const scheduler = new LatestDepthScheduler(controlledProvider(calls), {
        onOutcome: (outcome) => outcomes.push(outcome),
      });

      scheduler.submit(capture("expected", 10));
      calls[0]!.result.resolve(
        depthFrame(testCase.resultSourceFrameId, testCase.resultTimestamp),
      );
      await flush();

      assert.equal(scheduler.latestPublishedFrame, null);
      assert.deepEqual(discardedReasons(outcomes), ["mismatched"]);
    });
  }
});

test("stop and dispose fence late generations and close owned inputs", async (t) => {
  for (const action of ["stop", "dispose"] as const) {
    await t.test(action, async () => {
      const calls: ProviderCall[] = [];
      const outcomes: LatestDepthSchedulerOutcome[] = [];
      const scheduler = new LatestDepthScheduler(controlledProvider(calls), {
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      const active = capture(`${action}-active`, 1);
      const pending = capture(`${action}-pending`, 2);

      scheduler.submit(active);
      scheduler.submit(pending);
      if (action === "stop") scheduler.stop();
      else scheduler.dispose();

      assert.equal(scheduler.state.status, action === "stop" ? "stopped" : "disposed");
      assert.equal(scheduler.state.generation, 1);
      assert.equal(scheduler.state.hasPendingCapture, false);
      assert.equal(pending.frame.closeCount, 1);
      assert.equal(active.frame.closeCount, 0);

      calls[0]!.result.resolve(depthFrame(`${action}-active`, 1));
      await flush();

      assert.equal(scheduler.latestPublishedFrame, null);
      assert.equal(active.frame.closeCount, 1);
      assert.equal(scheduler.state.inferenceInFlight, false);
      assert.equal(calls.length, 1);
      assert.ok(discardedReasons(outcomes).includes("stale-generation"));

      const submittedAfterward = capture(`${action}-afterward`, 3);
      scheduler.submit(submittedAfterward);
      assert.equal(submittedAfterward.frame.closeCount, 1);
      assert.equal(calls.length, 1);
      assert.ok(discardedReasons(outcomes).includes("rejected"));
    });
  }
});
