// Tab completion of a directory typed after /cd. Only absolute paths and ~ are completed: a relative one
// means something different in the switcher (where toriel was started) and in a session (its own directory).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DirCompletion {
  value: string;
  description?: string;
}

const MOST = 30;

/** The subdirectories that continue `typed` (hidden ones only when the last part starts with a dot). */
export function dirCompletions(typed: string): DirCompletion[] {
  const text = typed.trimStart();
  if (!(text.startsWith("/") || text === "~" || text.startsWith("~/"))) {
    return [];
  }
  const slash = text.lastIndexOf("/");
  const parent = slash === -1 ? `${text}/` : text.slice(0, slash + 1);
  const partial = slash === -1 ? "" : text.slice(slash + 1);
  const real = parent.replace(/^~(?=\/)/, os.homedir());
  let names: string[];
  try {
    names = fs.readdirSync(real, { withFileTypes: true }).filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(real, e.name)))).map((e) => e.name);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(partial) && (partial.startsWith(".") || !n.startsWith(".")))
    .sort()
    .slice(0, MOST)
    .map((n) => ({ value: `${parent}${n}/` }));
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
