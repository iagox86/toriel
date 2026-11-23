#!/usr/bin/env node
// toriel: the controller. `toriel` (auto-starts the daemon), `toriel kill-server`, `toriel doctor`, `toriel update`, `toriel feedback`.
// Everything but preflight is imported dynamically: a missing dependency would
// otherwise fail at link time, before preflight could explain it.
import { preflight } from "./src/preflight.ts";

preflight();
if (process.argv[2] === "doctor") {
  const { doctorMain, realIo } = await import("./src/doctor-cli.ts");
  // loaded only when doctor gets as far as asking: with the setup broken these modules may not even link
  const daemonReport = async () => {
    const { buildInfo } = await import("./src/build-id.ts");
    const { probeDaemon } = await import("./src/lifecycle.ts");
    const { compareDaemon, describeDaemon } = await import("./src/version-check.ts");
    const local = buildInfo();
    const found = await probeDaemon();
    return found.up ? describeDaemon(local, found.hello, compareDaemon(local, found.hello)) : undefined;
  };
  // the feedback-size check needs the bundle directory; with the setup broken the module may not be there, and doctor must still explain itself
  const feedbackDir = await import("./src/config.ts").then((c) => c.FEEDBACK_DIR, () => undefined);
  process.exit(await doctorMain(process.argv.slice(3), realIo(), { feedbackDir }, daemonReport));
}
if (process.argv[2] === "update") {
  const { updateMain, realEnv } = await import("./src/update-cli.ts");
  process.exit(await updateMain(process.argv.slice(3), { write: (t) => void process.stdout.write(t) }, await realEnv()));
}
if (process.argv[2] === "feedback") {
  const { feedbackMain } = await import("./src/feedback-cli.ts");
  const { FEEDBACK_DIR } = await import("./src/config.ts");
  process.exit(await feedbackMain(process.argv.slice(3), { write: (t) => void process.stdout.write(t) }, { feedbackDir: FEEDBACK_DIR, cwd: process.cwd() }));
}
await import("./src/migrate-on-start.ts");
await import("./src/controller.ts");
