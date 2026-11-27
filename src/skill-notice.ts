// Which skill a read of a SKILL.md belongs to (ticket 317): the skill-load notice.
import { posix } from "node:path";

/** A plausible skill directory name: starts with a letter or digit, then letters/digits/._- (no parens, control or ANSI characters, `.`, `..`). */
const SKILL_NAME = /^[a-z0-9][a-z0-9_.-]*$/i;

/**
 * The skill name a path loads - the directory of `.../skills/<name>/SKILL.md` - or undefined for anything else:
 * another file of a skill, a SKILL.md with no `skills` directory in it, or no skill directory between `skills` and the file.
 * The path is normalized first (posix rules), so `skills/foo//SKILL.md` and `skills/foo/./SKILL.md` name foo, while
 * `skills/../SKILL.md` climbs out of `skills` and loads nothing. The name must then be a plausible directory name, so
 * `skills/h4x$%/SKILL.md` is not a skill either; a Windows-shaped path is ordinary characters on POSIX and not a load.
 * A path with several `skills` components takes the last one (the one closest to the file); the read tool reports the
 * path as given, so only the final components are judged, and non-path values are simply not a skill. The name comes
 * from the path as a literal string (symlinks are not resolved) - enough to tell one skill's file from another's here.
 */
export function skillNameFromPath(path: unknown): string | undefined {
  if (typeof path !== "string") {
    return undefined;
  }
  const parts = posix.normalize(path).split("/");
  if (parts.length < 3) {
    return undefined;
  }
  const file = parts[parts.length - 1];
  const name = parts[parts.length - 2];
  const dir = parts[parts.length - 3];
  if (file !== "SKILL.md" || dir !== "skills" || !SKILL_NAME.test(name)) {
    return undefined;
  }
  return name;
}
