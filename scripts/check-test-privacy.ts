import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { extname } from "node:path";
import { isIP } from "node:net";

interface Violation {
  category: string;
  file: string;
  line: number;
}

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".sh",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const FIXTURE_ACCOUNTS = new Set([
  "admin",
  "alice",
  "bob",
  "deploy",
  "dev",
  "developer",
  "example",
  "me",
  "test",
  "tester",
  "testuser",
  "user",
  "winuser",
]);

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "tests", "e2e"],
  { encoding: "utf8" },
)
  .split(/\r?\n/)
  .filter((file) => file && TEXT_EXTENSIONS.has(extname(file).toLowerCase()));

function optionalCommand(...args: string[]): string | undefined {
  try {
    const value = execFileSync(args[0], args.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

const localAccounts = new Set(
  [process.env.USER, process.env.USERNAME, process.env.LOGNAME]
    .filter((value): value is string => Boolean(value && value.length >= 2))
    .map((value) => value.toLowerCase()),
);

const privateNeedles = [
  { category: "local home path", value: homedir() },
  { category: "local workspace path", value: process.cwd() },
  { category: "local Windows profile", value: process.env.USERPROFILE },
  { category: "local Git email", value: optionalCommand("git", "config", "user.email") },
].filter(
  (item): item is { category: string; value: string } =>
    Boolean(item.value && item.value !== "/" && item.value.length >= 4),
);

const currentHostname = hostname();
const hostnamePattern = currentHostname && currentHostname.length >= 4 && currentHostname !== "localhost"
  ? new RegExp(
      `(?<![A-Za-z0-9_.-])${currentHostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_.-])`,
      "i",
    )
  : undefined;

const violations: Violation[] = [];
const seen = new Set<string>();

function report(category: string, file: string, line: number): void {
  const key = `${category}\0${file}\0${line}`;
  if (seen.has(key)) return;
  seen.add(key);
  violations.push({ category, file, line });
}

function isNonFixtureIpv4(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const [a, b, c] = value.split(".").map(Number);
  if (a === 0 || a === 127) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

for (const file of files) {
  const content = readFileSync(file, "utf8");
  if (content.includes("\0")) continue;
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    for (const needle of privateNeedles) {
      if (line.toLowerCase().includes(needle.value.toLowerCase())) {
        report(needle.category, file, lineNumber);
      }
      const sourceEscaped = needle.value.replaceAll("\\", "\\\\");
      if (
        sourceEscaped !== needle.value
        && line.toLowerCase().includes(sourceEscaped.toLowerCase())
      ) {
        report(needle.category, file, lineNumber);
      }
    }

    if (hostnamePattern?.test(line)) report("local hostname", file, lineNumber);

    for (const account of localAccounts) {
      const escaped = account.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const sshAccount = new RegExp(`(?<![A-Za-z0-9_.-])${escaped}@`, "i");
      const configAccount = new RegExp(`\\b(?:user|username)\\s*[:=]?\\s*[\"']?${escaped}(?![A-Za-z0-9_.-])`, "i");
      if (sshAccount.test(line) || configAccount.test(line)) {
        report("local account", file, lineNumber);
      }
    }

    for (const match of line.matchAll(/\/(?:home|Users)\/([^/\s'"`\\]+)\//g)) {
      const account = match[1].toLowerCase();
      const placeholder = account.startsWith("<") && account.endsWith(">");
      if (!placeholder && (localAccounts.has(account) || !FIXTURE_ACCOUNTS.has(account))) {
        report("non-fixture Unix home", file, lineNumber);
      }
    }

    const normalizedWindows = line.replaceAll("\\\\", "\\");
    for (const match of normalizedWindows.matchAll(/[A-Za-z]:\\Users\\([^\\\s'"`]+)\\/gi)) {
      const account = match[1].toLowerCase();
      const placeholder = account.startsWith("<") && account.endsWith(">");
      if (!placeholder && (localAccounts.has(account) || !FIXTURE_ACCOUNTS.has(account))) {
        report("non-fixture Windows profile", file, lineNumber);
      }
    }

    for (const match of line.matchAll(/(?<![\w:])(?:\d{1,3}\.){3}\d{1,3}(?![\w:])/g)) {
      if (isNonFixtureIpv4(match[0])) {
        report("non-documentation IPv4 address", file, lineNumber);
      }
    }

    if (/BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY/.test(line)) {
      report("private key material", file, lineNumber);
    }
    if (/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{24,})\b/.test(line)) {
      report("credential-shaped token", file, lineNumber);
    }

    for (const match of line.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)) {
      const domain = match[1].toLowerCase();
      const fixtureDomain = /^(?:example\.(?:com|net|org)|openssh\.com)$/.test(domain)
        || /(?:^|\.)(?:example|internal|invalid|localhost|test)$/.test(domain);
      if (!fixtureDomain) report("non-example email address", file, lineNumber);
    }
  });
}

if (violations.length > 0) {
  console.error("Potential local or sensitive test data detected:");
  for (const violation of violations.sort((left, right) =>
    left.file.localeCompare(right.file)
      || left.line - right.line
      || left.category.localeCompare(right.category)
  )) {
    console.error(`- ${violation.category}: ${violation.file}:${violation.line}`);
  }
  console.error("Use fixed fictional fixtures; do not commit local values.");
  process.exitCode = 1;
} else {
  console.log(`Test privacy check passed (${files.length} files scanned).`);
}
