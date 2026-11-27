// A node:test reporter for `npm run check` (ticket 340): it counts results and keeps each failure's name and first message
// line, and yields one JSON TestSummary at the end. check.ts sends it to a file next to the log and prints from that.
import { type Failure, firstLine, type TestSummary } from "./check-lib.ts";

interface EventData {
  name?: string;
  nesting?: number;
  file?: string;
  skip?: unknown;
  todo?: unknown;
  details?: { type?: string; error?: { message?: string; cause?: unknown } };
}

function failureMessage(error: { message?: string; cause?: unknown } | undefined): string {
  const cause = error?.cause as { message?: string } | undefined;
  return firstLine(String(cause?.message ?? error?.message ?? ""));
}

export default async function* checkReporter(source: AsyncIterable<{ type: string; data: EventData }>): AsyncGenerator<string> {
  const summary: TestSummary = { passed: 0, failed: 0, skipped: 0, failures: [] };
  // the names enclosing the running test, per file, by nesting level
  const stacks = new Map<string, string[]>();
  for await (const { type, data } of source) {
    const file = data.file ?? "";
    if (type === "test:start") {
      const stack = stacks.get(file) ?? [];
      stack.length = data.nesting ?? 0;
      stack.push(data.name ?? "");
      stacks.set(file, stack);
      continue;
    }
    if (type !== "test:pass" && type !== "test:fail") {
      continue;
    }
    // a suite's own result repeats its tests'; only a suite that failed by itself (a hook) is worth naming
    const suite = data.details?.type === "suite";
    if (type === "test:pass") {
      if (suite) {
        continue;
      }
      if (data.skip || data.todo) {
        summary.skipped++;
      } else {
        summary.passed++;
      }
      continue;
    }
    if (suite && (data.details?.error as { failureType?: string } | undefined)?.failureType === "subtestsFailed") {
      continue;
    }
    summary.failed++;
    const enclosing = (stacks.get(file) ?? []).slice(0, data.nesting ?? 0);
    const failure: Failure = { file: data.file ? relative(data.file) : undefined, path: [...enclosing, data.name ?? ""], message: failureMessage(data.details?.error) };
    summary.failures.push(failure);
  }
  yield `${JSON.stringify(summary)}\n`;
}

function relative(file: string): string {
  const cwd = process.cwd();
  return file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
}
