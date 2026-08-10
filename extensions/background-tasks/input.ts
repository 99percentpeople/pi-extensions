import type { BgTask } from "./types.ts";

export const MAX_INPUT_BYTES = 65_536;
const MAX_KEY_REPEAT = 100;

type KeyDefinition =
  | { kind: "character"; value: string }
  | { kind: "fixed"; sequence: string }
  | { kind: "cursor"; final: string }
  | { kind: "function"; final: string }
  | { kind: "tilde"; code: number }
  | { kind: "eof" };

const KEY_DEFINITIONS = {
  space: { kind: "character", value: " " },
  enter: { kind: "fixed", sequence: "\r" },
  escape: { kind: "fixed", sequence: "\x1b" },
  tab: { kind: "fixed", sequence: "\t" },
  backspace: { kind: "fixed", sequence: "\x7f" },
  insert: { kind: "tilde", code: 2 },
  delete: { kind: "tilde", code: 3 },
  pageup: { kind: "tilde", code: 5 },
  pagedown: { kind: "tilde", code: 6 },
  up: { kind: "cursor", final: "A" },
  down: { kind: "cursor", final: "B" },
  right: { kind: "cursor", final: "C" },
  left: { kind: "cursor", final: "D" },
  home: { kind: "cursor", final: "H" },
  end: { kind: "cursor", final: "F" },
  f1: { kind: "function", final: "P" },
  f2: { kind: "function", final: "Q" },
  f3: { kind: "function", final: "R" },
  f4: { kind: "function", final: "S" },
  f5: { kind: "tilde", code: 15 },
  f6: { kind: "tilde", code: 17 },
  f7: { kind: "tilde", code: 18 },
  f8: { kind: "tilde", code: 19 },
  f9: { kind: "tilde", code: 20 },
  f10: { kind: "tilde", code: 21 },
  f11: { kind: "tilde", code: 23 },
  f12: { kind: "tilde", code: 24 },
  eof: { kind: "eof" },
} as const satisfies Record<string, KeyDefinition>;
type NamedInputKey = keyof typeof KEY_DEFINITIONS;

const NAMED_KEY_ALIASES: Record<string, NamedInputKey> = {
  space: "space", spc: "space",
  esc: "escape", escape: "escape",
  enter: "enter", return: "enter", cr: "enter",
  tab: "tab", backtab: "tab",
  bs: "backspace", backspace: "backspace",
  ins: "insert", insert: "insert", del: "delete", delete: "delete",
  home: "home", end: "end",
  pageup: "pageup", pgup: "pageup", pagedown: "pagedown", pgdn: "pagedown",
  up: "up", down: "down", left: "left", right: "right",
  f1: "f1", f2: "f2", f3: "f3", f4: "f4", f5: "f5", f6: "f6",
  f7: "f7", f8: "f8", f9: "f9", f10: "f10", f11: "f11", f12: "f12",
  eof: "eof",
};

const CHARACTER_ALIASES: Record<string, string> = {
  lt: "<", gt: ">", backslash: "\\",
};

const MODIFIER_ALIASES = {
  c: "ctrl", ctrl: "ctrl", control: "ctrl",
  a: "alt", alt: "alt", m: "alt", meta: "alt",
  s: "shift", shift: "shift",
} as const;

const SHIFTED_CHARACTERS: Record<string, string> = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^",
  "7": "&", "8": "*", "9": "(", "0": ")", "-": "_", "=": "+",
  "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"",
  ",": "<", ".": ">", "/": "?", "`": "~",
};

const CONTROL_BYTES: Record<string, number> = {
  "@": 0x00, " ": 0x00, "[": 0x1b, "\\": 0x1c,
  "]": 0x1d, "^": 0x1e, "_": 0x1f, "?": 0x7f,
};

interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

type LogicalKey =
  | { kind: "named"; name: NamedInputKey }
  | { kind: "character"; value: string };

interface KeyStroke {
  kind: "key";
  key: LogicalKey;
  modifiers: KeyModifiers;
}

type NormalizedInputToken = KeyStroke | { kind: "literal"; value: string };

function hasModifiers(modifiers: KeyModifiers): boolean {
  return modifiers.ctrl || modifiers.alt || modifiers.shift;
}

function normalizeInputToken(token: string): NormalizedInputToken | null {
  let remaining = token.trim().replace(/\s+/g, "");
  const modifiers: KeyModifiers = { ctrl: false, alt: false, shift: false };

  while (remaining.length > 0) {
    const match = /^(c|ctrl|control|a|alt|m|meta|s|shift)[+-]/i.exec(remaining);
    if (!match) break;
    const modifier = MODIFIER_ALIASES[match[1].toLowerCase() as keyof typeof MODIFIER_ALIASES];
    if (modifiers[modifier]) return null;
    modifiers[modifier] = true;
    remaining = remaining.slice(match[0].length);
  }
  if (remaining.length === 0) return null;

  const lowerKey = remaining.toLowerCase();
  if (lowerKey === "lt" && !hasModifiers(modifiers)) return { kind: "literal", value: "<" };
  if (lowerKey === "backtab") modifiers.shift = true;

  const namedKey = NAMED_KEY_ALIASES[lowerKey];
  if (namedKey) return { kind: "key", key: { kind: "named", name: namedKey }, modifiers };

  const aliasedCharacter = CHARACTER_ALIASES[lowerKey];
  if (aliasedCharacter) {
    return { kind: "key", key: { kind: "character", value: aliasedCharacter }, modifiers };
  }

  const characters = Array.from(remaining);
  const codePoint = characters[0]?.codePointAt(0) ?? 0;
  if (hasModifiers(modifiers) && characters.length === 1 && codePoint >= 0x21 && codePoint <= 0x7e) {
    return { kind: "key", key: { kind: "character", value: remaining }, modifiers };
  }
  return null;
}

function modifierParameter(modifiers: KeyModifiers): number {
  return 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
}

function shiftCharacter(character: string): string {
  if (/^[a-z]$/.test(character)) return character.toUpperCase();
  return SHIFTED_CHARACTERS[character] ?? character;
}

function controlByte(character: string): number | null {
  const lower = character.toLowerCase();
  if (/^[a-z]$/.test(lower)) return lower.charCodeAt(0) - 96;
  return CONTROL_BYTES[character] ?? null;
}

function encodeCharacter(character: string, modifiers: KeyModifiers): Buffer {
  const byte = modifiers.ctrl ? controlByte(character) : null;
  if (modifiers.ctrl && byte === null) throw new Error(`Unsupported Ctrl key: ${character}`);
  const data = byte === null
    ? Buffer.from(modifiers.shift ? shiftCharacter(character) : character)
    : Buffer.from([byte]);
  return modifiers.alt ? Buffer.concat([Buffer.from("\x1b"), data]) : data;
}

function encodeInputKey(task: BgTask, stroke: KeyStroke): Buffer {
  if (stroke.key.kind === "character") return encodeCharacter(stroke.key.value, stroke.modifiers);

  const definition = KEY_DEFINITIONS[stroke.key.name];
  if (definition.kind === "character") return encodeCharacter(definition.value, stroke.modifiers);
  if (definition.kind === "eof") {
    if (hasModifiers(stroke.modifiers)) throw new Error("<EOF> does not accept modifiers.");
    return Buffer.from([0x04]);
  }
  if (definition.kind === "fixed") {
    const sequence = stroke.key.name === "tab" && stroke.modifiers.shift ? "\x1b[Z" : definition.sequence;
    return stroke.modifiers.alt
      ? Buffer.concat([Buffer.from("\x1b"), Buffer.from(sequence)])
      : Buffer.from(sequence);
  }

  const parameter = modifierParameter(stroke.modifiers);
  if (definition.kind === "cursor") {
    if (parameter > 1) return Buffer.from(`\x1b[1;${parameter}${definition.final}`);
    const prefix = task.console.terminal.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
    return Buffer.from(`${prefix}${definition.final}`);
  }
  if (definition.kind === "function") {
    return Buffer.from(parameter > 1
      ? `\x1b[1;${parameter}${definition.final}`
      : `\x1bO${definition.final}`);
  }
  return Buffer.from(parameter > 1
    ? `\x1b[${definition.code};${parameter}~`
    : `\x1b[${definition.code}~`);
}

function isNamedKey(stroke: KeyStroke, name: NamedInputKey): boolean {
  return stroke.key.kind === "named" && stroke.key.name === name;
}

function isPipeEof(stroke: KeyStroke): boolean {
  if (isNamedKey(stroke, "eof")) return !hasModifiers(stroke.modifiers);
  return stroke.key.kind === "character" && stroke.key.value.toLowerCase() === "d" &&
    stroke.modifiers.ctrl && !stroke.modifiers.alt;
}

export interface ParsedInput {
  data: Buffer;
  eof: boolean;
  keyTokens: number;
  textBytes: number;
}

export function parseInput(task: BgTask, input: string): ParsedInput {
  if (input.length === 0) throw new Error("Input cannot be empty; use <Enter> to press Enter.");

  const chunks: Buffer[] = [];
  let expandedBytes = 0;
  let keyTokens = 0;
  let textBytes = 0;
  let eof = false;

  const pushChunk = (chunk: Buffer, text: boolean): void => {
    expandedBytes += chunk.length;
    if (expandedBytes > MAX_INPUT_BYTES) throw new Error(`Expanded input exceeds ${MAX_INPUT_BYTES} bytes.`);
    chunks.push(chunk);
    if (text) textBytes += chunk.length;
  };

  let cursor = 0;
  let textStart = 0;
  while (cursor < input.length) {
    if (input[cursor] === "\\" && (input[cursor + 1] === "<" || input[cursor + 1] === "\\")) {
      if (cursor > textStart) pushChunk(Buffer.from(input.slice(textStart, cursor), "utf-8"), true);
      pushChunk(Buffer.from(input[cursor + 1], "utf-8"), true);
      cursor += 2;
      textStart = cursor;
      continue;
    }
    if (input[cursor] !== "<") {
      cursor += 1;
      continue;
    }

    const tokenStart = cursor;
    if (tokenStart > textStart) pushChunk(Buffer.from(input.slice(textStart, tokenStart), "utf-8"), true);

    const tokenEnd = input.indexOf(">", tokenStart + 1);
    if (tokenEnd === -1) throw new Error(`Unclosed input token at offset ${tokenStart}; use \\< for a literal '<'.`);
    const rawToken = input.slice(tokenStart + 1, tokenEnd);
    const repeated = /^(.*?)(?:\*([0-9]+))?$/.exec(rawToken);
    const tokenName = repeated?.[1] ?? rawToken;
    const repeat = repeated?.[2] === undefined ? 1 : Number(repeated[2]);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_KEY_REPEAT) {
      throw new Error(`Invalid repeat count in <${rawToken}> at offset ${tokenStart}; use 1-${MAX_KEY_REPEAT}.`);
    }

    const token = normalizeInputToken(tokenName);
    if (!token) throw new Error(`Unknown input token <${tokenName}> at offset ${tokenStart}.`);

    if (token.kind === "literal") {
      pushChunk(Buffer.from(token.value.repeat(repeat)), true);
    } else {
      keyTokens += repeat;
      if (task.mode === "pipe") {
        if (isPipeEof(token)) {
          if (repeat !== 1) throw new Error("Ctrl+D/<EOF> cannot be repeated for a pipe task.");
          eof = true;
        } else if (isNamedKey(token, "enter") && !hasModifiers(token.modifiers)) {
          pushChunk(Buffer.from("\n".repeat(repeat)), false);
        } else if (isNamedKey(token, "space") && !hasModifiers(token.modifiers)) {
          pushChunk(Buffer.from(" ".repeat(repeat)), false);
        } else {
          throw new Error(`Key token <${tokenName}> requires a PTY task; pipe tasks accept text, <Space>, <Enter>, and <C-d>/<EOF>.`);
        }
      } else {
        const encoded = encodeInputKey(task, token);
        for (let index = 0; index < repeat; index++) pushChunk(encoded, false);
      }
    }

    cursor = tokenEnd + 1;
    textStart = cursor;
  }
  if (textStart < input.length) pushChunk(Buffer.from(input.slice(textStart), "utf-8"), true);

  const data = Buffer.concat(chunks);
  if (eof && (data.length > 0 || keyTokens !== 1)) {
    throw new Error("For a pipe task, Ctrl+D/<EOF> must be the only input token.");
  }
  return { data, eof, keyTokens, textBytes };
}
