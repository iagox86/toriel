#!/usr/bin/env node
// toriel: the controller. `toriel` (auto-starts the daemon), `toriel kill-server`, `toriel doctor`.
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
  process.exit(await doctorMain(process.argv.slice(3), realIo(), {}, daemonReport));
}
await import("./src/migrate-on-start.ts");
await import("./src/controller.ts");
