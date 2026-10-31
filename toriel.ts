#!/usr/bin/env node
// toriel: the controller. `toriel` (auto-starts the daemon), `toriel kill-server`.
// Everything but preflight is imported dynamically: a missing dependency would
// otherwise fail at link time, before preflight could explain it.
import { preflight } from "./src/preflight.ts";

preflight();
await import("./src/migrate-on-start.ts");
await import("./src/controller.ts");
