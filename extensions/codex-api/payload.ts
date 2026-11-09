import type { CodexApiConfig } from "./config.ts";

export function applyFastModePayload(payload: unknown, enabled: boolean): unknown {
  if (!enabled || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return { ...(payload as Record<string, unknown>), service_tier: "priority" };
}

export function applyResponseVerbosityPayload(
  payload: unknown,
  verbosity: CodexApiConfig["responseVerbosity"],
): unknown {
  if (verbosity === "auto" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  const text = record.text && typeof record.text === "object" && !Array.isArray(record.text)
    ? record.text as Record<string, unknown>
    : {};
  return { ...record, text: { ...text, verbosity } };
}

export function applyCodexProviderPayload(payload: unknown, config: CodexApiConfig): unknown {
  return applyResponseVerbosityPayload(
    applyFastModePayload(payload, config.fastMode),
    config.responseVerbosity,
  );
}
