#!/usr/bin/env node
// toriel: the controller. `toriel` (auto-starts the daemon), `toriel kill-server`, `toriel doctor`.
// Everything but preflight is imported dynamically: a missing dependency would
// otherwise fail at link time, before preflight could explain it.
import { preflight } from "./src/preflight.ts";

preflight();
if (process.argv[2] === "doctor") {
  const { doctorMain, realIo } = await import("./src/doctor-cli.ts");
  process.exit(await doctorMain(process.argv.slice(3), realIo()));
}
await import("./src/migrate-on-start.ts");
await import("./src/controller.ts");
