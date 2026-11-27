// Which skill a read of a SKILL.md belongs to (ticket 317): the skill-load notice.

/**
 * The skill name a path loads - the directory of `.../skills/<name>/SKILL.md` - or undefined for anything else:
 * another file of a skill, a SKILL.md with no `skills` directory in it, or no skill directory between `skills` and the file.
 * A path with several `skills` components takes the last one (the one closest to the file); the read tool reports the path
 * as given, so only the final components are judged, and non-path values are simply not a skill.
 */
export function skillNameFromPath(path: unknown): string | undefined {
  if (typeof path !== "string") {
    return undefined;
  }
  const parts = path.split("/");
  if (parts.length < 3) {
    return undefined;
  }
  const file = parts[parts.length - 1];
  const name = parts[parts.length - 2];
  const dir = parts[parts.length - 3];
  if (file !== "SKILL.md" || dir !== "skills" || name.length === 0) {
    return undefined;
  }
  return name;
}
