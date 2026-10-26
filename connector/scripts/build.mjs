import { build } from "esbuild";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: {
    cli: "src/cli.ts",
    server: "src/server-entry.ts",
    api: "src/public.ts",
  },
  outdir: "build",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["@napi-rs/keyring"],
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __energyCreateRequire } from "node:module"; const require = __energyCreateRequire(import.meta.url);',
  },
  legalComments: "linked",
  sourcemap: false,
});
for (const name of ["cli", "server"])
  await chmod(`${root}/build/${name}.mjs`, 0o755);
