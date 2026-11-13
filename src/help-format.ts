// Colour for the /help screens. The text itself comes from cli.ts (listing(),
// commander's per-command help) and is not changed: these functions only add
// SGR escapes around tokens, so stripping them gives back the plain text.
import { accent, dim } from "./theme.ts";

export interface HelpStyle {
  /** command names, section headers and flags */
  name: (s: string) => string;
  /** usage hints and footers */
  quiet: (s: string) => string;
}

const THEME: HelpStyle = { name: accent, quiet: dim };

/** `listing()` output: names accented, usage hints dim, the footer dim, descriptions untouched. */
export function styleListing(text: string, style: HelpStyle = THEME): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("/") && line.includes("  ")) {
        // "/name <usage>      description": the padding after the usage is at least two spaces
        const m = /^(\/\S+)(.*?)( {2,})(.*)$/.exec(line);
        if (m) {
          const [, name, usage, pad, description] = m as unknown as [string, string, string, string, string];
          return `${style.name(name)}${usage === "" ? "" : style.quiet(usage)}${pad}${description}`;
        }
      }
      if (/^\/\S+$/.test(line)) {
        return style.name(line);
      }
      return line.trim() === "" ? line : style.quiet(line);
    })
    .join("\n");
}

const HEADER = /^[A-Z][A-Za-z ]*:$/;
// an option line: indent, the flags (with any <value>; up to the first run of two spaces), then the description
const FLAGS = /^(\s+)(-.+?)(\s{2,}.*|)$/;

/**
 * One command's help page (commander's usage, arguments and options, then the
 * command's own `help:` prose and examples): section headers, argument names and flag names
 * accented, the usage line's label too, everything else as it is.
 */
export function styleHelp(text: string, style: HelpStyle = THEME): string {
  let section = "";
  return text
    .split("\n")
    .map((line) => {
      if (HEADER.test(line)) {
        section = line;
        return style.name(line);
      }
      if (line.startsWith("Usage: ")) {
        return `${style.name("Usage:")}${line.slice("Usage:".length)}`;
      }
      if (line.trim() === "") {
        section = "";
        return line;
      }
      if (section === "Arguments:" && /^ {2}\S/.test(line)) {
        const m = /^(\s+)(\S+)(.*)$/.exec(line);
        if (m) {
          const [, indent, arg, rest] = m as unknown as [string, string, string, string];
          return `${indent}${style.name(arg)}${rest}`;
        }
      }
      if (section === "Options:" || section === "Commands:") {
        const m = FLAGS.exec(line);
        if (m) {
          const [, indent, flag, rest] = m as unknown as [string, string, string, string];
          return `${indent}${style.name(flag)}${rest}`;
        }
      }
      return line;
    })
    .join("\n");
}
