import { StringEnum } from "@earendil-works/pi-ai";
import {
  withFileMutationQueue,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type Static, Type } from "typebox";
import { DSH_EDITOR_DESCRIPTION } from "./payload.ts";

const TRUNCATED_MESSAGE = "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";
const DEFAULT_MAX_OUTPUT_CHARS = 16_000;

export const strReplaceEditorSchema = Type.Object({
  command: StringEnum(["view", "create", "str_replace", "insert"] as const, {
    description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
  }),
  path: Type.String({
    description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.",
  }),
  file_text: Type.Optional(Type.String({
    description: "Required parameter of `create` command, with the content of the file to be created.",
  })),
  insert_line: Type.Optional(Type.Integer({
    description: "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
  })),
  new_str: Type.Optional(Type.String({
    description: "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
  })),
  old_str: Type.Optional(Type.String({
    description: "Required parameter of `str_replace` command containing the string in `path` to replace.",
  })),
  view_range: Type.Optional(Type.Array(Type.Integer(), {
    description: "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
  })),
}, { additionalProperties: false });

export type StrReplaceEditorInput = Static<typeof strReplaceEditorSchema>;

function assertAbsolutePath(path: string): void {
  if (path.trim().length === 0) throw new Error("path must be a non-empty string");
  if (!isAbsolute(path)) {
    throw new Error(`The path ${path} is not an absolute path. Please provide an absolute path.`);
  }
}

function maybeTruncate(content: string, maxOutputChars: number): string {
  return content.length <= maxOutputChars
    ? content
    : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE;
}

async function existingType(path: string): Promise<"file" | "directory"> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`The path ${path} does not exist. Please provide a valid path.`);
    }
    throw error;
  }
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  throw new Error(`The path ${path} is not a regular file or directory.`);
}

function formatFileView(
  path: string,
  content: string,
  maxOutputChars: number,
  viewRange?: number[],
): string {
  const allLines = content.split("\n");
  let lines = allLines;
  let initialLine = 1;
  let finalLine: number | undefined;
  let heading = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;

  if (viewRange !== undefined) {
    const [requestedInitial, requestedFinal] = viewRange;
    if (
      viewRange.length !== 2
      || requestedInitial === undefined
      || requestedFinal === undefined
      || !viewRange.every(Number.isInteger)
    ) {
      throw new Error("Invalid `view_range`. It should be a list of two integers.");
    }
    initialLine = requestedInitial;
    finalLine = requestedFinal;
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
      );
    }
    if (finalLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``,
      );
    }
    if (finalLine !== -1 && finalLine < initialLine) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``,
      );
    }
    lines = finalLine === -1
      ? allLines.slice(initialLine - 1)
      : allLines.slice(initialLine - 1, finalLine);
    heading += ` with view_range=[${initialLine}, ${finalLine}]`;
  }

  const numbered = lines
    .map((line, index) => `${String(initialLine + index).padStart(6, " ")}  ${line}`)
    .join("\n");
  return maybeTruncate(`${heading}:\n${numbered}\n`, maxOutputChars);
}

async function listDirectory(path: string, maxOutputChars: number): Promise<string> {
  const rows = [`d\t${path}`];
  const visit = async (directory: string, depth: number): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name.startsWith(".")
        || entry.name === "node_modules"
        || entry.name === "__pycache__"
      ) continue;
      const target = join(directory, entry.name);
      const type = entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?";
      rows.push(`${type}\t${target}`);
      if (entry.isDirectory() && depth < 2) await visit(target, depth + 1);
    }
  };
  await visit(path, 1);
  rows.sort((left, right) => {
    const leftPath = left.slice(left.indexOf("\t") + 1);
    const rightPath = right.slice(right.indexOf("\t") + 1);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  const listing = maybeTruncate(`${rows.join("\n")}\n`, maxOutputChars);
  return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`;
}

async function viewPath(path: string, viewRange: number[] | undefined, maxOutputChars: number): Promise<string> {
  const type = await existingType(path);
  if (type === "directory") {
    if (viewRange !== undefined) {
      throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.");
    }
    return listDirectory(path, maxOutputChars);
  }
  return formatFileView(path, await readFile(path, "utf8"), maxOutputChars, viewRange);
}

function requiredString(
  value: string | undefined,
  parameter: string,
  command: string,
  allowEmpty = true,
): string {
  if (value === undefined) throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`);
  if (!allowEmpty && value.length === 0) {
    throw new Error(`Parameter \`${parameter}\` is empty for command: ${command}`);
  }
  return value;
}

function matchOffsets(content: string, search: string): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  while (true) {
    const offset = content.indexOf(search, cursor);
    if (offset < 0) return offsets;
    offsets.push(offset);
    cursor = offset + search.length;
  }
}

function lineNumbersAt(content: string, offsets: number[]): number[] {
  return offsets.map((offset) => content.slice(0, offset).split("\n").length);
}

async function createFile(path: string, fileText: string | undefined): Promise<string> {
  const content = requiredString(fileText, "file_text", "create");
  return withFileMutationQueue(path, async () => {
    try {
      await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`File already exists at: ${path}. Cannot overwrite files using command \`create\`.`);
      }
      throw error;
    }
    return `New file created successfully at: ${path}`;
  });
}

async function replaceInFile(
  path: string,
  oldString: string | undefined,
  newString: string | undefined,
): Promise<string> {
  const oldValue = requiredString(oldString, "old_str", "str_replace", false);
  return withFileMutationQueue(path, async () => {
    if (await existingType(path) !== "file") {
      throw new Error(`The path ${path} is a directory and cannot be edited.`);
    }
    const before = await readFile(path, "utf8");
    const offsets = matchOffsets(before, oldValue);
    const offset = offsets[0];
    if (offset === undefined) {
      throw new Error(`No replacement was performed, old_str \`${oldValue}\` did not appear verbatim in ${path}.`);
    }
    if (offsets.length > 1) {
      const lines = lineNumbersAt(before, offsets);
      throw new Error(
        `No replacement was performed. Multiple occurrences of old_str \`${oldValue}\` in lines [${lines.join(", ")}]. Please ensure it is unique`,
      );
    }
    const next = before.slice(0, offset) + (newString ?? "") + before.slice(offset + oldValue.length);
    await writeFile(path, next, "utf8");
    return `The file ${path} has been edited successfully.`;
  });
}

async function insertInFile(
  path: string,
  insertLine: number | undefined,
  newString: string | undefined,
): Promise<string> {
  if (insertLine === undefined) throw new Error("Parameter `insert_line` is required for command: insert");
  const value = requiredString(newString, "new_str", "insert");
  return withFileMutationQueue(path, async () => {
    if (await existingType(path) !== "file") {
      throw new Error(`The path ${path} is a directory and cannot be edited.`);
    }
    const before = await readFile(path, "utf8");
    const lines = before.split("\n");
    if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
      throw new Error(
        `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
      );
    }
    const next = [
      ...lines.slice(0, insertLine),
      ...value.split("\n"),
      ...lines.slice(insertLine),
    ].join("\n");
    await writeFile(path, next, "utf8");
    return `The file ${path} has been edited successfully.`;
  });
}

export function registerStrReplaceEditor(
  pi: ExtensionAPI,
  options: { maxOutputChars?: number } = {},
): void {
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  pi.registerTool({
    name: "str_replace_editor",
    label: "str_replace_editor",
    description: DSH_EDITOR_DESCRIPTION,
    promptSnippet: "View, create, replace, or insert text through the DSH-compatible editor",
    promptGuidelines: [
      "Use str_replace_editor only with absolute paths and copy old_str exactly from a prior view.",
    ],
    parameters: strReplaceEditorSchema,
    async execute(_toolCallId, input) {
      assertAbsolutePath(input.path);
      let text: string;
      switch (input.command) {
        case "view":
          text = await viewPath(input.path, input.view_range, maxOutputChars);
          break;
        case "create":
          text = await createFile(input.path, input.file_text);
          break;
        case "str_replace":
          text = await replaceInFile(input.path, input.old_str, input.new_str);
          break;
        case "insert":
          text = await insertInFile(input.path, input.insert_line, input.new_str);
          break;
      }
      return { content: [{ type: "text", text }], details: {} };
    },
    renderCall(input, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("str_replace_editor"))} ${theme.fg("muted", `${input.command} ${input.path}`)}`,
        0,
        0,
      );
    },
  });
}

export const DSH_EDITOR_TRUNCATED_MESSAGE = TRUNCATED_MESSAGE;
