import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

interface ReusableRenderContext {
  lastComponent: Component | undefined;
}

export function reusableText(context: ReusableRenderContext): Text {
  return context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
}

export function streamingSuffix(theme: Theme, argsComplete: boolean): string {
  return argsComplete ? "" : theme.fg("dim", " …");
}

export function textOutput(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((item): item is { type: "text"; text: string } =>
      item.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text)
    .join("\n");
}
