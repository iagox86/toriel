// Auto mode (ticket 213): a session whose permission prompts the daemon answers "Yes" itself, so a long stretch of agent work does
// not stop at every probe and build step. The point is the FLOOR: the prompts that still reach the user however the mode is set.
//
// The floor is a lexical check on what pi asked about, so it is a convenience and not a boundary: a command can hide what it does
// (`eval`, a variable, a script it wrote a moment ago). The real boundary is the sandbox (docs/sandbox-spike.md); the floor catches
// the plain, common forms and errs toward asking, because a false positive costs one prompt and a false negative costs a lot more.
import { exemptPaths, protectedPaths, touchesProtected } from "./daemon-permissions.ts";
import type { AskRule } from "./shared.ts";

/**
 * Whether `request` is a permission prompt (pi-permission-system's "Permission Required" select with a plain Yes and No), as opposed
 * to another extension's select. The title matters: a question an agent puts to the user (the ask-the-user tool) can offer "Yes" and
 * "No" too, and auto mode must never answer that one for the user.
 */
export function isPermissionPrompt(request: Record<string, unknown>): boolean {
  const options = Array.isArray(request.options) ? request.options : [];
  const title = typeof request.title === "string" ? request.title : "";
  return request.method === "select" && typeof request.id === "string" && title.startsWith("Permission Required") && options.includes("Yes") && options.includes("No");
}

/** Where tools and shells split one command into several: `&&`, `||`, `;`, `|`, `&`, a newline, a backtick, `(`, `)` and `$(`. */
const SEPARATORS = /&&|\|\||\$\(|[;|&\n`()]/;

/** Words a command can be run through; the real command follows them. */
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "time", "nice", "ionice", "xargs", "builtin", "timeout"]);

const unquote = (t: string): string => t.replace(/^["']+|["']+$/g, "");

/** A program's name without its directory (`/usr/bin/sudo` is `sudo`). */
const base = (w: string): string => w.slice(w.lastIndexOf("/") + 1);

/** Programs that run the code in their next argument, so what they do is hidden from a reader of the command line: `sh -c '...'`, `python -c`, `node -e`. */
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python2", "python3", "node", "nodejs", "perl", "ruby", "php", "deno", "bun", "lua"]);

/** The commands of one shell line, each as its words (quotes stripped, leading `VAR=value` words and wrapper words skipped). */
export function shellCommands(text: string): string[][] {
  const out: string[][] = [];
  for (const part of text.split(SEPARATORS)) {
    const words = part.trim().split(/\s+/).filter(Boolean).map(unquote).filter(Boolean);
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string) || WRAPPERS.has(base(words[i] as string)))) {
      i++;
    }
    if (i < words.length) {
      out.push([base(words[i] as string), ...words.slice(i + 1)]);
    }
  }
  return out;
}

/** A word that names somewhere beyond the working tree: absolute, `~`, `$VAR`, a `..` path, or the whole of the tree (`.`, `*`). */
const reachesOut = (w: string): boolean => (/^(\/|~|\$)/.test(w) && !/^\/(var\/)?tmp(\/|$)/.test(w)) || w === "." || w === "*" || w === ".." || w.startsWith("../") || w.includes("/../") || w.endsWith("/..");

/** Devices a redirection may name without leaving the working tree in any way that matters. */
const HARMLESS_DEVICE = /^\/dev\/(null|zero|stdout|stderr|stdin|tty|fd\/\d+)$/;

/** Output flags that name a file or directory the program writes to, per program (ticket 217). */
const OUTPUT_FLAGS: Readonly<Record<string, { short: readonly string[]; long: readonly string[] }>> = {
  curl: { short: ["-o"], long: ["--output", "--output-dir"] },
  wget: { short: ["-O", "-P"], long: ["--output-document", "--directory-prefix"] },
  tar: { short: ["-C"], long: ["--directory"] },
  unzip: { short: ["-d"], long: [] },
  sort: { short: ["-o"], long: ["--output"] },
};

/**
 * Where a command writes besides its operands (ticket 217): redirection targets (`> f`, `>> f`, `2> f`, `&> f`), the file arguments of
 * `tee`, a copy or move's destination, and the values of a few output flags. The caller asks whether any of them leaves the tree.
 */
export function writeTargets(words: string[]): string[] {
  const out: string[] = [];
  const cmd = words[0] as string;
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as string;
    const m = /^(?:\d*|&)>>?(.*)$/.exec(w);
    if (m !== null) {
      const target = (m[1] as string) !== "" ? (m[1] as string) : (words[i + 1] ?? "");
      if (target !== "" && !HARMLESS_DEVICE.test(target)) {
        out.push(target);
      }
      continue;
    }
    const flags = OUTPUT_FLAGS[cmd];
    if (flags !== undefined) {
      const eq = /^(--[\w-]+)=(.*)$/.exec(w);
      if (eq !== null && flags.long.includes(eq[1] as string)) {
        out.push(eq[2] as string);
      } else if (flags.short.includes(w) || flags.long.includes(w)) {
        out.push(words[i + 1] ?? "");
      } else if (w.length > 2 && flags.short.includes(w.slice(0, 2)) && /^-[A-Za-z]/.test(w) && !/^-[A-Za-z]{2,}$/.test(w)) {
        out.push(w.slice(2)); // -o/path
      }
    }
  }
  const operands = words.slice(1).filter((w) => !w.startsWith("-") && !/^(\d*|&)>/.test(w));
  if (cmd === "tee") {
    out.push(...operands);
  } else if ((cmd === "cp" || cmd === "mv" || cmd === "install" || cmd === "ln") && operands.length >= 2) {
    out.push(operands[operands.length - 1] as string);
  }
  return out.filter((t) => t !== "" && !HARMLESS_DEVICE.test(t));
}

const hasFlag = (words: string[], short: RegExp, long: readonly string[]): boolean => words.some((w) => (/^-[A-Za-z]+$/.test(w) && short.test(w)) || long.includes(w));

/** Commands that destroy or rewrite storage whatever their arguments. */
const DISK_TOOLS = new Set(["dd", "mkfs", "mkswap", "wipefs", "shred", "fdisk", "sfdisk", "cfdisk", "parted", "gdisk", "blkdiscard", "cryptsetup", "lvremove", "vgremove", "pvremove", "zpool", "mdadm"]);

/** Commands that publish, release or push to somewhere other people (or the machine's future self) will see. */
function publishes(words: string[]): boolean {
  const [cmd, ...rest] = words;
  const sub = (skip: ReadonlySet<string>): string | undefined => {
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i] as string;
      if (skip.has(w)) {
        i++; // an option with its own value (git -C dir)
      } else if (!w.startsWith("-")) {
        return w;
      }
    }
    return undefined;
  };
  switch (cmd) {
    case "git":
      return sub(new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"])) === "push";
    case "gh": {
      const [a, b] = rest.filter((w) => !w.startsWith("-"));
      return (a === "pr" && (b === "merge" || b === "close")) || a === "release" || (a === "repo" && (b === "delete" || b === "create" || b === "edit")) || (a === "api" && hasFlag(rest, /X/, ["--method"]) && rest.some((w) => /^(POST|PUT|PATCH|DELETE)$/i.test(w)));
    }
    case "npm":
    case "yarn":
    case "pnpm":
    case "cargo":
    case "gem":
      return rest.includes("publish") || (cmd === "gem" && rest.includes("push"));
    case "twine":
      return rest.includes("upload");
    case "docker":
    case "podman":
      return rest.includes("push");
    default:
      return false;
  }
}

/** Why a command line must be asked about even in auto mode, or undefined when it may go ahead. */
export function commandFloor(text: string): string | undefined {
  if (/(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\b(ba|z)?sh\s+<\(\s*(curl|wget)/.test(text)) {
    return "it runs code it downloads";
  }
  if (/>\s*\/dev\/(sd|nvme|hd|vd|mmcblk|loop|disk)/.test(text)) {
    return "it writes to a disk device";
  }
  // `&> f` and `>& f` redirect both streams to a file; keep them whole, because `&` also separates commands
  for (const words of shellCommands(text.replace(/&>>?/g, ">").replace(/>&(?=\s*[^\s\d&-])/g, ">"))) {
    const cmd = words[0] as string;
    if (INTERPRETERS.has(cmd) && words.slice(1).some((w) => /^-[A-Za-z]*[ce]$|^--(command|eval|exec)$/.test(w))) {
      return "it runs code given on its command line, which hides what it does";
    }
    if (writeTargets(words).some((t) => t !== "." && reachesOut(t))) {
      return "it writes to a file outside the working tree";
    }
    const operands = words.slice(1).filter((w) => !w.startsWith("-"));
    if (cmd === "rm" || cmd === "rmdir" || cmd === "unlink") {
      if (operands.some(reachesOut)) {
        return "it deletes files outside the working tree, or all of it";
      }
    } else if (cmd === "chmod" || cmd === "chown" || cmd === "chgrp") {
      if (hasFlag(words, /R/, ["--recursive"]) && operands.some(reachesOut)) {
        return `it changes ${cmd === "chmod" ? "permissions" : "ownership"} recursively outside the working tree`;
      }
    } else if (cmd === "find" && (words.includes("-delete") || (words.includes("-exec") && words.some((w) => w === "rm" || w === "shred"))) && operands.some(reachesOut)) {
      return "it deletes files outside the working tree, or all of it";
    } else if (DISK_TOOLS.has(cmd) && (cmd !== "dd" || words.some((w) => w.startsWith("of="))) && (cmd !== "zpool" || words.includes("destroy"))) {
      return "it rewrites or wipes storage";
    } else if (cmd.startsWith("mkfs.")) {
      return "it rewrites or wipes storage";
    } else if (cmd === "su" || cmd === "pkexec") {
      return "it switches to another user";
    } else if (publishes(words)) {
      return "it pushes or publishes to a remote";
    }
  }
  if (/(^|[\s;&|(`/])(sudo|doas|pkexec)\s/.test(text)) {
    return "it runs with elevated privileges";
  }
  return undefined;
}

/** Files that hold secrets; asking about reading or writing one always reaches the user. */
const CREDENTIAL_FILES =
  /(^|[/\s"'=:~])(\.ssh|\.gnupg|\.aws|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.docker\/config\.json|\.kube\/config|id_(rsa|dsa|ecdsa|ed25519)|auth\.json|mcp-auth\.json|models\.json|(credentials|secrets?)\.(json|ya?ml|env|toml)|\.env(\.[\w-]+)?|chatto[\w-]*\.token)(?![\w-])|\/etc\/(shadow|sudoers|gshadow)|\.(pem|p12|pfx|keystore|kdbx)(?![\w-])/i;

export interface FloorInput {
  /** The dialog's text (title and message). */
  title: string;
  /** What the ask is about (the command, the path, the tool), when the grants link reported it. */
  value?: string;
  /** The grant specs pi suggested for the ask (surface and pattern), when known. */
  surfaces?: ReadonlyArray<{ surface: string }>;
  /** Why pi asks, as the grants link reported it; undefined when it did not. */
  rule?: AskRule;
}

/** The bash command an ask is about: its reported value, else the `command : ...` line of the dialog. */
function commandOf(inp: FloorInput): string | undefined {
  const bash = inp.surfaces?.some((s) => s.surface === "bash");
  if (inp.value !== undefined && (bash || inp.surfaces === undefined || inp.surfaces.length === 0)) {
    return inp.value;
  }
  return /^\s*command\s*:\s*(.+)$/ms.exec(inp.title)?.[1];
}

/**
 * Why a permission prompt must still reach the user in auto mode, or undefined when auto mode may answer it. The floor, from
 * ticket 213: the permission grants file and pi's configuration (minus the agent-maintained memory subtrees, ticket 246 -
 * but only on a non-bash ask, since a command's `..` run cannot be resolved across squashed `&&` tokens), credential and secret
 * files, writes outside the session's directory, destructive filesystem commands, pushes and publishes, privilege escalation
 * and code piped from the network. Anything pi itself denies never becomes a prompt.
 */
export function floorReason(inp: FloorInput): string | undefined {
  const all = `${inp.title}\n${inp.value ?? ""}`;
  const command = commandOf(inp);
  // a command (or an ask with no surface report, which could be one) keeps the strict check: see the docblock
  if (touchesProtected(all, protectedPaths(), command !== undefined ? [] : exemptPaths())) {
    return "it names the permission grants file or pi's own configuration";
  }
  if (CREDENTIAL_FILES.test(all)) {
    return "it names a credential or secret file";
  }
  if (inp.surfaces?.some((s) => s.surface === "external_directory_write")) {
    return "it writes outside the session's directory";
  }
  if (command !== undefined) {
    // pi wraps a long command across lines mid-word, and a real newline separates two commands: with no unwrapped value to go by, both readings are checked
    const found = commandFloor(command) ?? (inp.value === undefined ? commandFloor(command.replace(/\n/g, "")) : undefined);
    if (found !== undefined) {
      return found;
    }
  }
  // what the owner configured to ask about is asked about: only the catch-all default is auto mode's to answer. No report means the link could not tell, which is not a yes either
  if (inp.rule === undefined) {
    return "auto mode cannot tell whether your permission config asks about this one on purpose";
  }
  if (inp.rule.explicit) {
    return `your permission config asks about this one${inp.rule.pattern !== undefined ? ` (rule ${JSON.stringify(inp.rule.pattern)})` : ""}`;
  }
  return undefined;
}

/** What a prompt is about, in a few words for a notice: the reported value, else its `command :`, `path :` or `tool :` line (a wrapped command is joined), else its text. */
export function promptSubject(title: string, value?: string): string {
  if (value) {
    return value;
  }
  for (const label of ["command", "path", "tool"]) {
    const m = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "ms").exec(title);
    if (m?.[1]) {
      return label === "command" ? m[1].replace(/\n/g, "") : (m[1].split("\n")[0] as string).trim();
    }
  }
  return title.replace(/\s+/g, " ").trim();
}
