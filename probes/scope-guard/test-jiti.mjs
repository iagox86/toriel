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
