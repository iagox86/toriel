// The controller side of /doctor: the setup report in a panel, and with --fix a confirmation
// before anything is written. Shared by the session and switcher command tables.
import type { Invocation } from "./cli.ts";
import { applyFixes, type DoctorOptions, plannedFixes, previewFixes, renderDoctor, runDoctor } from "./doctor.ts";
import type { Host } from "./host.ts";
import { errText } from "./util.ts";

/** `/doctor [--fix]`. A running controller has passed the start-up checks, so those are not repeated. */
export function runDoctorCommand(h: Host, call: Invocation, opts: DoctorOptions = {}): void {
  const checks = runDoctor({ ...opts, startup: [] });
  const report = renderDoctor(checks, { compact: true });
  if (call.opts.fix !== true) {
    h.infoPanel.show(report);
    h.tui.requestRender();
    return;
  }
  const plan = plannedFixes(checks);
  if (plan.length === 0) {
    h.infoPanel.show(`${report}\n\nNothing here can be fixed automatically.`);
    h.tui.requestRender();
    return;
  }
  const shown: string[] = [];
  const doable = plan.flatMap(({ file, fixes }) => {
    try {
      shown.push(`${file}\n${fixes.map((f) => `  - ${f.summary}`).join("\n")}\n${previewFixes(file, fixes)}`);
      return [{ file, fixes }];
    } catch (err) {
      shown.push(`${file}\n  cannot change this file: ${errText(err)}`);
      return [];
    }
  });
  h.infoPanel.show(`${report}\n\nProposed changes:\n\n${shown.join("\n\n")}`);
  if (doable.length > 0) {
    h.choicePanel.open("Apply these changes? (each original is kept as <file>.bak-<time>)", ["Apply", "Cancel"], undefined, (choice) => {
      if (choice !== "Apply") {
        h.notify("doctor: nothing changed");
        return;
      }
      const results = doable.map(({ file, fixes }) => {
        try {
          return `changed ${file} (original kept at ${applyFixes(file, fixes)})`;
        } catch (err) {
          return `could not change ${file}: ${errText(err)}`;
        }
      });
      h.notify(`doctor: ${results.join("; ")}`);
      runDoctorCommand(h, { args: [], opts: {} }, opts);
    });
  }
  h.tui.requestRender();
}
