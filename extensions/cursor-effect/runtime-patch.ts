import type { Theme } from "@earendil-works/pi-coding-agent";
import { Loader, type LoaderIndicatorOptions } from "@earendil-works/pi-tui";
import type { CustomCursorEffects } from "./config.ts";
import {
  cursorEffectFrame,
  labelFrameInterval,
  renderLabelEffect,
  type ResolvedLabelEffect,
} from "./effects/label.ts";
import type { ResolvedCursorTheme } from "./effects/theme.ts";

const PATCH_SYMBOL = Symbol.for("@99percentpeople/pi-cursor-effect/working-status-patch");
const MAIN_STATUS_KINDS = new Set(["working", "retry", "compaction", "branchSummary"]);
const NATIVE_LOADER_INTERVAL_MS = 80;

type RuntimeLoader = {
  kind?: string;
  message: string;
  messageColorFn: (text: string) => string;
  updateDisplay(): void;
  setIndicator(options?: LoaderIndicatorOptions): void;
  stop(): void;
  render(width: number): string[];
};

interface LabelState {
  label: string;
  revision: number;
  startedAt: number;
}

interface LabelTimerState {
  intervalMs: number;
  revision: number;
  timer: ReturnType<typeof setInterval>;
}

interface PatchState {
  references: number;
  originalUpdateDescriptor: PropertyDescriptor | undefined;
  originalRenderDescriptor: PropertyDescriptor | undefined;
  originalStopDescriptor: PropertyDescriptor | undefined;
  theme?: Pick<Theme, "fg" | "bold">;
  indicator?: LoaderIndicatorOptions;
  labelEffect: ResolvedLabelEffect;
  revision: number;
  originalUpdate: (this: RuntimeLoader) => void;
  patchedUpdate: (this: RuntimeLoader) => void;
  originalRender: (this: RuntimeLoader, width: number) => string[];
  patchedRender: (this: RuntimeLoader, width: number) => string[];
  originalStop: (this: RuntimeLoader) => void;
  patchedStop: (this: RuntimeLoader) => void;
  labelTimers: Map<RuntimeLoader, LabelTimerState>;
}

export interface CursorEffectPatchHandle {
  setTheme(theme: Pick<Theme, "fg" | "bold">): void;
  setResolvedTheme(resolved: ResolvedCursorTheme): void;
  setLabelEffect(effect: ResolvedLabelEffect): void;
  setLabelConfig(config: CustomCursorEffects["label"]): void;
  dispose(): void;
}

const loaderPrototype = Loader.prototype as unknown as RuntimeLoader & { [PATCH_SYMBOL]?: PatchState };

function isMainStatus(loader: RuntimeLoader): boolean {
  return typeof loader.kind === "string" && MAIN_STATUS_KINDS.has(loader.kind);
}

function resolvedLabelConfig(config: CustomCursorEffects["label"]): ResolvedLabelEffect {
  return config.style === "none"
    ? { style: "none" }
    : { ...config, style: config.style };
}

function releasePatch(state: PatchState): void {
  state.references -= 1;
  if (state.references > 0) return;
  for (const timerState of state.labelTimers.values()) clearInterval(timerState.timer);
  state.labelTimers.clear();
  if (loaderPrototype.updateDisplay === state.patchedUpdate) {
    if (state.originalUpdateDescriptor) {
      Object.defineProperty(loaderPrototype, "updateDisplay", state.originalUpdateDescriptor);
    } else delete (loaderPrototype as unknown as Record<PropertyKey, unknown>).updateDisplay;
  }
  if (loaderPrototype.render === state.patchedRender) {
    if (state.originalRenderDescriptor) {
      Object.defineProperty(loaderPrototype, "render", state.originalRenderDescriptor);
    } else delete (loaderPrototype as unknown as Record<PropertyKey, unknown>).render;
  }
  if (loaderPrototype.stop === state.patchedStop) {
    if (state.originalStopDescriptor) {
      Object.defineProperty(loaderPrototype, "stop", state.originalStopDescriptor);
    } else delete (loaderPrototype as unknown as Record<PropertyKey, unknown>).stop;
  }
  delete (loaderPrototype as unknown as Record<PropertyKey, unknown>)[PATCH_SYMBOL];
}

function createHandle(state: PatchState): CursorEffectPatchHandle {
  let disposed = false;
  return {
    setTheme: (theme) => { state.theme = theme; },
    setResolvedTheme: (resolved) => {
      state.indicator = structuredClone(resolved.indicator);
      state.labelEffect = structuredClone(resolved.label);
      state.revision += 1;
    },
    setLabelEffect: (effect) => {
      state.labelEffect = structuredClone(effect);
      state.revision += 1;
    },
    setLabelConfig: (config) => {
      state.labelEffect = resolvedLabelConfig(structuredClone(config));
      state.revision += 1;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      releasePatch(state);
    },
  };
}

export function installCursorEffectPatch(
  initial: ResolvedLabelEffect | CustomCursorEffects["label"] = { style: "none" },
): CursorEffectPatchHandle {
  const initialEffect = "speed" in initial ? resolvedLabelConfig(initial) : initial;
  const existing = loaderPrototype[PATCH_SYMBOL];
  if (existing) {
    existing.references += 1;
    existing.labelEffect = structuredClone(initialEffect);
    existing.revision += 1;
    return createHandle(existing);
  }

  const originalUpdateDescriptor = Object.getOwnPropertyDescriptor(loaderPrototype, "updateDisplay");
  const originalRenderDescriptor = Object.getOwnPropertyDescriptor(loaderPrototype, "render");
  const originalStopDescriptor = Object.getOwnPropertyDescriptor(loaderPrototype, "stop");
  const originalUpdate = loaderPrototype.updateDisplay;
  const originalRender = loaderPrototype.render;
  const originalStop = loaderPrototype.stop;
  if (
    typeof originalUpdate !== "function"
    || typeof originalRender !== "function"
    || typeof originalStop !== "function"
  ) throw new Error("Loader rendering methods are unavailable");

  const states = new WeakMap<object, LabelState>();
  const appliedIndicatorRevisions = new WeakMap<object, number>();
  let patchState: PatchState;

  const clearLabelTimer = (loader: RuntimeLoader) => {
    const current = patchState.labelTimers.get(loader);
    if (!current) return;
    clearInterval(current.timer);
    patchState.labelTimers.delete(loader);
  };

  const loaderRefreshInterval = (): number => {
    const frames = patchState.indicator?.frames;
    if (frames !== undefined && frames.length <= 1) return Number.POSITIVE_INFINITY;
    return patchState.indicator?.intervalMs ?? NATIVE_LOADER_INTERVAL_MS;
  };

  const ensureLabelTimer = (loader: RuntimeLoader) => {
    const effect = patchState.labelEffect;
    if (
      !isMainStatus(loader)
      || !patchState.theme
      || effect.style === "none"
      || loader.message.includes("\u001b")
    ) {
      clearLabelTimer(loader);
      return;
    }
    const intervalMs = labelFrameInterval(effect);
    if (loaderRefreshInterval() <= intervalMs) {
      clearLabelTimer(loader);
      return;
    }
    const current = patchState.labelTimers.get(loader);
    if (
      current
      && current.intervalMs === intervalMs
      && current.revision === patchState.revision
    ) return;
    clearLabelTimer(loader);
    const timer = setInterval(() => {
      if (!isMainStatus(loader)) {
        clearLabelTimer(loader);
        return;
      }
      patchState.patchedUpdate.call(loader);
    }, intervalMs);
    timer.unref?.();
    patchState.labelTimers.set(loader, { intervalMs, revision: patchState.revision, timer });
  };

  const patchedUpdate = function (this: RuntimeLoader): void {
    const effect = patchState.labelEffect;
    if (
      !isMainStatus(this)
      || !patchState.theme
      || effect.style === "none"
      || this.message.includes("\u001b")
    ) {
      clearLabelTimer(this);
      originalUpdate.call(this);
      return;
    }
    ensureLabelTimer(this);
    const now = Date.now();
    let state = states.get(this);
    if (!state || state.revision !== patchState.revision) {
      state = { label: this.message, revision: patchState.revision, startedAt: now };
      states.set(this, state);
    } else if (state.label !== this.message) {
      // Streaming labels may change frequently; preserve the current effect phase.
      state.label = this.message;
    }
    const originalColor = this.messageColorFn;
    this.messageColorFn = (text) => renderLabelEffect(
      text,
      cursorEffectFrame(state!.startedAt, now, labelFrameInterval(effect)),
      effect,
      patchState.theme!,
    );
    try {
      originalUpdate.call(this);
    } finally {
      this.messageColorFn = originalColor;
    }
  };

  const patchedRender = function (this: RuntimeLoader, width: number): string[] {
    if (isMainStatus(this) && appliedIndicatorRevisions.get(this) !== patchState.revision) {
      // StatusIndicator assigns `kind` only after Loader's constructor has run.
      // Applying on its first render avoids a native frame and refreshes visible
      // retry/compaction indicators after a settings change.
      appliedIndicatorRevisions.set(this, patchState.revision);
      this.setIndicator(structuredClone(patchState.indicator));
    }
    ensureLabelTimer(this);
    return originalRender.call(this, width);
  };

  const patchedStop = function (this: RuntimeLoader): void {
    clearLabelTimer(this);
    originalStop.call(this);
  };

  patchState = {
    references: 1,
    originalUpdateDescriptor,
    originalRenderDescriptor,
    originalStopDescriptor,
    labelEffect: structuredClone(initialEffect),
    revision: 0,
    originalUpdate,
    patchedUpdate,
    originalRender,
    patchedRender,
    originalStop,
    patchedStop,
    labelTimers: new Map(),
  };

  Object.defineProperty(loaderPrototype, "updateDisplay", {
    configurable: true,
    writable: true,
    value: patchedUpdate,
  });
  Object.defineProperty(loaderPrototype, "render", {
    configurable: true,
    writable: true,
    value: patchedRender,
  });
  Object.defineProperty(loaderPrototype, "stop", {
    configurable: true,
    writable: true,
    value: patchedStop,
  });
  Object.defineProperty(loaderPrototype, PATCH_SYMBOL, { configurable: true, value: patchState });
  return createHandle(patchState);
}
