import type { Model, Api } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type CodexAuthContext = Pick<ExtensionContext, "model" | "modelRegistry">;
export type CodexTextModel = Model<"openai-responses"> | Model<"openai-codex-responses">;

/** API-key logins must never silently turn a subscription tool into a paid API call. */
export function isChatGPTSubscriptionModel(
  ctx: CodexAuthContext,
  model: Model<Api> | undefined = ctx.model,
): boolean {
  return !!model
    && (model.provider === "openai-codex"
      || (model.provider === "openai" && model.api === "openai-responses"))
    && ctx.modelRegistry.isUsingOAuth(model);
}

export function isCodexTextModel(
  ctx: CodexAuthContext,
  model: Model<Api>,
): model is CodexTextModel {
  return ((model.provider === "openai" && model.api === "openai-responses")
    || (model.provider === "openai-codex" && model.api === "openai-codex-responses"))
    && ctx.modelRegistry.isUsingOAuth(model);
}

/** This is an active-model gate, not permission to reuse OpenAI OAuth on ChatGPT endpoints. */
export function codexToolsAllowed(ctx: CodexAuthContext, allowOtherProviders: boolean): boolean {
  return allowOtherProviders || isChatGPTSubscriptionModel(ctx);
}
