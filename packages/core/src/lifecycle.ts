import type { EngineLifecycleState } from "./contracts.ts";

export interface LifecycleTransition {
  readonly previous: EngineLifecycleState;
  readonly current: EngineLifecycleState;
  readonly generation: number;
}

export type LifecycleTransitionCallback = (
  transition: LifecycleTransition,
) => void;

export type InitializeOutcome =
  | { readonly status: "ready" }
  | {
      readonly status: "superseded";
      readonly state: EngineLifecycleState;
    }
  | {
      readonly status: "invalid-state";
      readonly state: EngineLifecycleState;
    };

export type StopOutcome =
  | { readonly status: "stopped"; readonly changed: boolean }
  | {
      readonly status: "invalid-state";
      readonly state: EngineLifecycleState;
    };

export type DeviceLostOutcome =
  | { readonly status: "failed"; readonly changed: boolean }
  | {
      readonly status: "invalid-state";
      readonly state: EngineLifecycleState;
    };

export class EngineLifecycleController {
  private readonly onTransition: LifecycleTransitionCallback | undefined;
  private currentState: EngineLifecycleState = "new";
  private currentGeneration = 0;
  private initialization: Promise<InitializeOutcome> | undefined;

  public constructor(onTransition?: LifecycleTransitionCallback) {
    this.onTransition = onTransition;
  }

  public get state(): EngineLifecycleState {
    return this.currentState;
  }

  public get generation(): number {
    return this.currentGeneration;
  }

  public get canUpdate(): boolean {
    return this.currentState === "ready";
  }

  public initialize(
    initializer: () => Promise<void>,
  ): Promise<InitializeOutcome> {
    if (this.currentState === "initializing" && this.initialization) {
      return this.initialization;
    }

    if (this.currentState !== "new") {
      return Promise.resolve({
        status: "invalid-state",
        state: this.currentState,
      });
    }

    this.transitionTo("initializing");
    const generation = this.currentGeneration;
    const pending = Promise.resolve().then(initializer);

    this.initialization = pending.then(
      (): InitializeOutcome => {
        if (
          this.currentState !== "initializing" ||
          this.currentGeneration !== generation
        ) {
          return { status: "superseded", state: this.currentState };
        }

        this.transitionTo("ready");
        return { status: "ready" };
      },
      (error: unknown): InitializeOutcome => {
        if (
          this.currentState !== "initializing" ||
          this.currentGeneration !== generation
        ) {
          return { status: "superseded", state: this.currentState };
        }

        this.transitionTo("failed");
        throw error;
      },
    );

    return this.initialization;
  }

  public stop(): StopOutcome {
    if (this.currentState === "stopped") {
      return { status: "stopped", changed: false };
    }

    if (
      this.currentState !== "new" &&
      this.currentState !== "initializing" &&
      this.currentState !== "ready"
    ) {
      return { status: "invalid-state", state: this.currentState };
    }

    this.currentGeneration += 1;
    this.transitionTo("stopping");
    this.transitionTo("stopped");
    return { status: "stopped", changed: true };
  }

  public markDeviceLost(): DeviceLostOutcome {
    if (this.currentState === "failed") {
      return { status: "failed", changed: false };
    }

    if (
      this.currentState !== "initializing" &&
      this.currentState !== "ready"
    ) {
      return { status: "invalid-state", state: this.currentState };
    }

    this.currentGeneration += 1;
    this.transitionTo("failed");
    return { status: "failed", changed: true };
  }

  private transitionTo(current: EngineLifecycleState): void {
    const previous = this.currentState;
    this.currentState = current;

    try {
      this.onTransition?.({
        previous,
        current,
        generation: this.currentGeneration,
      });
    } catch {
      // Lifecycle integrity must not depend on observer behavior.
    }
  }
}
