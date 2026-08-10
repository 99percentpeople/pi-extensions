import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface CodexToolFeature<Config> {
  toolName: string;
  isEnabled(config: Config): boolean;
}

function replaceActiveTools(pi: ExtensionAPI, next: string[], current: string[]): void {
  if (
    next.length === current.length
    && next.every((toolName, index) => toolName === current[index])
  ) {
    return;
  }
  pi.setActiveTools(next);
}

/**
 * Apply persisted Off switches without overriding a user's narrower initial
 * tool selection. Enabled features are deliberately not added here.
 */
export function disableUnavailableCodexTools<Config>(
  pi: ExtensionAPI,
  config: Config,
  features: readonly CodexToolFeature<Config>[],
): void {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
  const disabled = new Set(
    features
      .filter((feature) => !feature.isEnabled(config))
      .map((feature) => feature.toolName),
  );
  if (disabled.size === 0) return;
  const current = pi.getActiveTools();
  replaceActiveTools(
    pi,
    current.filter((toolName) => !disabled.has(toolName)),
    current,
  );
}

/** Enable or disable only features changed through /99settings. */
export function applyCodexToolFeatureChanges<Config>(
  pi: ExtensionAPI,
  previous: Config,
  next: Config,
  features: readonly CodexToolFeature<Config>[],
): void {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
  const changed = features.filter((feature) =>
    feature.isEnabled(previous) !== feature.isEnabled(next)
  );
  if (changed.length === 0) return;

  const current = pi.getActiveTools();
  const active = new Set(current);
  for (const feature of changed) {
    if (feature.isEnabled(next)) active.add(feature.toolName);
    else active.delete(feature.toolName);
  }

  const updated = current.filter((toolName) => active.has(toolName));
  for (const feature of changed) {
    if (feature.isEnabled(next) && !updated.includes(feature.toolName)) {
      updated.push(feature.toolName);
    }
  }
  replaceActiveTools(pi, updated, current);
}
