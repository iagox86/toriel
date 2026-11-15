if (process.env.NODE_TEST_CONTEXT !== undefined) {
  // `node --test` sweeps any test-*.mjs in the tree as a test file; this probe is run by hand, not by the suite.
  console.error("test-jiti.mjs is a probe, not a test file: run it directly; use npm test for the suite");
  process.exit(0);
}
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
try {
  const mod = await jiti.import('/home/ron/.nvm/versions/node/v27.0.0-alpha.0.0.0/lib/node_modules/@gotgenes/pi-permission-system/src/access-intent/bash/program.ts');
  console.log("SUCCESS: loaded BashProgram module");
  console.log("Keys:", Object.keys(mod));
} catch (e) {
  console.error("FAILED:", e.message);
  console.error(e.stack?.split('\n').slice(0,5).join('\n'));
}
