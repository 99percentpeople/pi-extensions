import type { AnchorProfile } from "./config.ts";

export const DSH_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`;

export const DSH_EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``;

export const DSH_BASH_PARAMETERS = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "The bash command to run. Relative path is preferred in the command.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

export const DSH_EDITOR_PARAMETERS = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["view", "create", "str_replace", "insert"],
      description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
    },
    path: {
      type: "string",
      description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.",
    },
    file_text: {
      type: "string",
      description: "Required parameter of `create` command, with the content of the file to be created.",
    },
    insert_line: {
      type: "integer",
      description: "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
    },
    new_str: {
      type: "string",
      description: "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
    },
    old_str: {
      type: "string",
      description: "Required parameter of `str_replace` command containing the string in `path` to replace.",
    },
    view_range: {
      type: "array",
      items: { type: "integer" },
      description: "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
    },
  },
  required: ["command", "path"],
  additionalProperties: false,
} as const;

export interface PayloadShapeResult {
  payload: unknown;
  applied: boolean;
  toolNames: string[];
  reason?: string;
}

export interface SystemAnchorOptions {
  systemPrompt: string;
}

type PayloadRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PayloadRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function functionToolName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.name === "string") return value.name;
  if (isRecord(value.function) && typeof value.function.name === "string") {
    return value.function.name;
  }
  return undefined;
}

export function listPayloadToolNames(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return [];
  return payload.tools
    .map(functionToolName)
    .filter((name): name is string => name !== undefined);
}

export function extractSystemText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (Array.isArray(payload.messages)) {
    const system = payload.messages.find((message) =>
      isRecord(message) && (message.role === "system" || message.role === "developer"));
    if (isRecord(system)) {
      if (typeof system.content === "string") return system.content;
      if (Array.isArray(system.content)) {
        const text = system.content.find((part) => isRecord(part) && typeof part.text === "string");
        if (isRecord(text) && typeof text.text === "string") return text.text;
      }
    }
  }
  if (typeof payload.instructions === "string") return payload.instructions;
  if (typeof payload.system === "string") return payload.system;
  if (Array.isArray(payload.system)) {
    const text = payload.system.find((part) => isRecord(part) && typeof part.text === "string");
    if (isRecord(text) && typeof text.text === "string") return text.text;
  }
  if (isRecord(payload.systemInstruction)) {
    const parts = payload.systemInstruction.parts;
    if (Array.isArray(parts)) {
      const text = parts.find((part) => isRecord(part) && typeof part.text === "string");
      if (isRecord(text) && typeof text.text === "string") return text.text;
    }
  }
  return undefined;
}

function canonicalizeSystemPrompt(payload: PayloadRecord, text: string): {
  payload: PayloadRecord;
  applied: boolean;
} {
  const next = { ...payload };

  if (Array.isArray(payload.messages)) {
    const messages = payload.messages.filter((message) =>
      !isRecord(message) || (message.role !== "system" && message.role !== "developer"));
    next.messages = [{ role: "system", content: text }, ...messages];
    delete next.instructions;
    delete next.system;
    delete next.systemInstruction;
    return { payload: next, applied: true };
  }

  if ("instructions" in payload) {
    next.instructions = text;
    delete next.system;
    delete next.systemInstruction;
    return { payload: next, applied: true };
  }

  if ("system" in payload) {
    next.system = text;
    delete next.instructions;
    delete next.systemInstruction;
    return { payload: next, applied: true };
  }

  if ("systemInstruction" in payload) {
    next.systemInstruction = { parts: [{ text }] };
    delete next.instructions;
    delete next.system;
    return { payload: next, applied: true };
  }

  return { payload, applied: false };
}

function exactToolDefinitions(style: "openai" | "anthropic"): unknown[] {
  const definitions = [
    { name: "bash", description: DSH_BASH_DESCRIPTION, parameters: DSH_BASH_PARAMETERS },
    {
      name: "str_replace_editor",
      description: DSH_EDITOR_DESCRIPTION,
      parameters: DSH_EDITOR_PARAMETERS,
    },
  ];

  if (style === "anthropic") {
    return definitions.map(({ name, description, parameters }) => ({
      name,
      description,
      input_schema: structuredClone(parameters),
    }));
  }
  return definitions.map(({ name, description, parameters }) => ({
    type: "function",
    function: { name, description, parameters: structuredClone(parameters) },
  }));
}

function detectToolStyle(tools: unknown[]): "openai" | "anthropic" {
  return tools.some((tool) => isRecord(tool) && isRecord(tool.function))
    ? "openai"
    : "anthropic";
}

export function shapeAnchoredPayload(
  payload: unknown,
  options: SystemAnchorOptions,
): PayloadShapeResult {
  if (!isRecord(payload)) {
    return { payload, applied: false, toolNames: [], reason: "provider payload is not an object" };
  }

  const system = canonicalizeSystemPrompt(payload, options.systemPrompt);
  if (!system.applied) {
    return {
      payload,
      applied: false,
      toolNames: listPayloadToolNames(payload),
      reason: "provider payload has no recognized system-prompt carrier",
    };
  }

  return {
    payload: system.payload,
    applied: true,
    toolNames: listPayloadToolNames(system.payload),
  };
}

export function shapeBootstrapPayload(
  payload: unknown,
  options: {
    profile: AnchorProfile;
    systemPrompt: string;
    bootstrapTools: string[];
  },
): PayloadShapeResult {
  if (!isRecord(payload)) {
    return { payload, applied: false, toolNames: [], reason: "provider payload is not an object" };
  }

  const system = canonicalizeSystemPrompt(payload, options.systemPrompt);
  if (!system.applied) {
    return {
      payload,
      applied: false,
      toolNames: listPayloadToolNames(payload),
      reason: "provider payload has no recognized system-prompt carrier",
    };
  }

  if (!Array.isArray(system.payload.tools)) {
    return {
      payload,
      applied: false,
      toolNames: [],
      reason: "provider payload has no tools array",
    };
  }

  const next = { ...system.payload };
  if (options.profile === "exact-dsh") {
    next.tools = exactToolDefinitions(detectToolStyle(system.payload.tools));
  } else {
    const allowed = new Set(options.bootstrapTools);
    next.tools = system.payload.tools.filter((tool) => {
      const name = functionToolName(tool);
      return name !== undefined && allowed.has(name);
    });
    const present = new Set((next.tools as unknown[]).map(functionToolName));
    const missing = options.bootstrapTools.filter((name) => !present.has(name));
    if (missing.length > 0) {
      return {
        payload,
        applied: false,
        toolNames: listPayloadToolNames(payload),
        reason: `provider payload is missing bootstrap tools: ${missing.join(", ")}`,
      };
    }
  }

  return {
    payload: next,
    applied: true,
    toolNames: listPayloadToolNames(next),
  };
}
