import assert from "node:assert/strict";
import test from "node:test";

import type { EngineLifecycleState } from "../src/contracts.ts";
import {
  EngineLifecycleController,
  type LifecycleTransition,
} from "../src/lifecycle.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function states(transitions: readonly LifecycleTransition[]): string[] {
  return transitions.map(({ previous, current, generation }) =>
    `${previous}->${current}@${generation}`,
  );
}

test("starts new with generation zero and cannot update", () => {
  const lifecycle = new EngineLifecycleController();

  assert.equal(lifecycle.state, "new");
  assert.equal(lifecycle.generation, 0);
  assert.equal(lifecycle.canUpdate, false);
});

test("initialize transitions through initializing to ready", async () => {
  const transitions: LifecycleTransition[] = [];
  const initialization = deferred<void>();
  const lifecycle = new EngineLifecycleController((transition) => {
    transitions.push(transition);
  });

  const result = lifecycle.initialize(() => initialization.promise);
  assert.equal(lifecycle.state, "initializing");
  assert.equal(lifecycle.canUpdate, false);
  assert.equal(lifecycle.generation, 0);

  initialization.resolve(undefined);
  assert.deepEqual(await result, { status: "ready" });
  assert.equal(lifecycle.state, "ready");
  assert.equal(lifecycle.canUpdate, true);
  assert.equal(lifecycle.generation, 0);
  assert.deepEqual(states(transitions), [
    "new->initializing@0",
    "initializing->ready@0",
  ]);
});

test("concurrent initialize calls share one operation", async () => {
  const initialization = deferred<void>();
  const lifecycle = new EngineLifecycleController();
  let calls = 0;
  const initializer = () => {
    calls += 1;
    return initialization.promise;
  };

  const first = lifecycle.initialize(initializer);
  const second = lifecycle.initialize(initializer);
  assert.strictEqual(first, second);

  initialization.resolve(undefined);
  assert.deepEqual(await first, { status: "ready" });
  assert.equal(calls, 1);
});

test("initializer rejection moves to failed and preserves the error", async () => {
  const transitions: LifecycleTransition[] = [];
  const initialization = deferred<void>();
  const lifecycle = new EngineLifecycleController((transition) => {
    transitions.push(transition);
  });
  const error = new Error("initialization failed");

  const result = lifecycle.initialize(() => initialization.promise);
  initialization.reject(error);

  await assert.rejects(result, (received) => received === error);
  assert.equal(lifecycle.state, "failed");
  assert.equal(lifecycle.canUpdate, false);
  assert.equal(lifecycle.generation, 0);
  assert.deepEqual(states(transitions), [
    "new->initializing@0",
    "initializing->failed@0",
  ]);
});

test("stop during initialize ignores a late resolution", async () => {
  const transitions: LifecycleTransition[] = [];
  const initialization = deferred<void>();
  const lifecycle = new EngineLifecycleController((transition) => {
    transitions.push(transition);
  });

  const result = lifecycle.initialize(() => initialization.promise);
  assert.deepEqual(lifecycle.stop(), { status: "stopped", changed: true });
  assert.equal(lifecycle.state, "stopped");
  assert.equal(lifecycle.generation, 1);

  initialization.resolve(undefined);
  assert.deepEqual(await result, { status: "superseded", state: "stopped" });
  assert.equal(lifecycle.state, "stopped");
  assert.equal(lifecycle.generation, 1);
  assert.equal(lifecycle.canUpdate, false);
  assert.deepEqual(states(transitions), [
    "new->initializing@0",
    "initializing->stopping@1",
    "stopping->stopped@1",
  ]);
});

test("stop during initialize handles a late rejection", async () => {
  const initialization = deferred<void>();
  const lifecycle = new EngineLifecycleController();
  const result = lifecycle.initialize(() => initialization.promise);

  lifecycle.stop();
  initialization.reject(new Error("late failure"));

  assert.deepEqual(await result, { status: "superseded", state: "stopped" });
  assert.equal(lifecycle.state, "stopped");
  assert.equal(lifecycle.generation, 1);
});

test("device loss during initialization fails once and supersedes completion", async () => {
  const transitions: LifecycleTransition[] = [];
  const initialization = deferred<void>();
  const lifecycle = new EngineLifecycleController((transition) => {
    transitions.push(transition);
  });
  const result = lifecycle.initialize(() => initialization.promise);

  assert.deepEqual(lifecycle.markDeviceLost(), {
    status: "failed",
    changed: true,
  });
  assert.deepEqual(lifecycle.markDeviceLost(), {
    status: "failed",
    changed: false,
  });
  assert.equal(lifecycle.generation, 1);

  initialization.resolve(undefined);
  assert.deepEqual(await result, { status: "superseded", state: "failed" });
  assert.deepEqual(states(transitions), [
    "new->initializing@0",
    "initializing->failed@1",
  ]);
});

test("device loss from ready disables updates and increments once", async () => {
  const lifecycle = new EngineLifecycleController();
  assert.deepEqual(await lifecycle.initialize(() => Promise.resolve()), {
    status: "ready",
  });

  assert.deepEqual(lifecycle.markDeviceLost(), {
    status: "failed",
    changed: true,
  });
  assert.equal(lifecycle.state, "failed");
  assert.equal(lifecycle.canUpdate, false);
  assert.equal(lifecycle.generation, 1);
  assert.deepEqual(lifecycle.markDeviceLost(), {
    status: "failed",
    changed: false,
  });
  assert.equal(lifecycle.generation, 1);
});

test("stop is idempotent and increments generation exactly once", async () => {
  const transitions: LifecycleTransition[] = [];
  const lifecycle = new EngineLifecycleController((transition) => {
    transitions.push(transition);
  });
  await lifecycle.initialize(() => Promise.resolve());

  assert.deepEqual(lifecycle.stop(), { status: "stopped", changed: true });
  assert.deepEqual(lifecycle.stop(), { status: "stopped", changed: false });
  assert.equal(lifecycle.state, "stopped");
  assert.equal(lifecycle.generation, 1);
  assert.deepEqual(states(transitions), [
    "new->initializing@0",
    "initializing->ready@0",
    "ready->stopping@1",
    "stopping->stopped@1",
  ]);
});

test("invalid calls return typed outcomes without changing state", async () => {
  const lifecycle = new EngineLifecycleController();

  assert.deepEqual(lifecycle.markDeviceLost(), {
    status: "invalid-state",
    state: "new",
  });
  assert.equal(lifecycle.state, "new");
  assert.equal(lifecycle.generation, 0);

  await lifecycle.initialize(() => Promise.resolve());
  assert.deepEqual(
    await lifecycle.initialize(() => Promise.resolve()),
    { status: "invalid-state", state: "ready" },
  );
  assert.equal(lifecycle.state, "ready");
  assert.equal(lifecycle.generation, 0);
});

test("transition callback exceptions are isolated", async () => {
  const observed: EngineLifecycleState[] = [];
  const lifecycle = new EngineLifecycleController(({ current }) => {
    observed.push(current);
    throw new Error("observer failure");
  });

  assert.deepEqual(await lifecycle.initialize(() => Promise.resolve()), {
    status: "ready",
  });
  assert.equal(lifecycle.state, "ready");
  assert.deepEqual(observed, ["initializing", "ready"]);

  assert.deepEqual(lifecycle.stop(), { status: "stopped", changed: true });
  assert.equal(lifecycle.state, "stopped");
  assert.deepEqual(observed, ["initializing", "ready", "stopping", "stopped"]);
});
