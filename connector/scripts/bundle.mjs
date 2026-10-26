import { readFile, mkdir, writeFile } from "node:fs/promises";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", root), "utf8"),
);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
if (
  manifest.version !== pkg.version ||
  manifest.server.entry_point !== "server/server.mjs"
)
  throw new Error("Bundle manifest and package must agree.");
for (const key of ["glow_username", "glow_password"])
  if (!manifest.user_config[key].sensitive)
    throw new Error("Credential fields must use secure host storage.");
const files = {};
for (const [dest, source] of Object.entries({
  "manifest.json": "manifest.json",
  "server/server.mjs": "build/server.mjs",
  "README.md": "README.md",
  LICENSE: "LICENSE",
  "server/server.mjs.LEGAL.txt": "build/server.mjs.LEGAL.txt",
})) {
  try {
    files[dest] = [
      new Uint8Array(await readFile(new URL(source, root))),
      { mtime: new Date("2026-01-01T00:00:00Z") },
    ];
  } catch (error) {
    if (source.endsWith(".LEGAL.txt") && error.code === "ENOENT") continue;
    throw error;
  }
}
const bytes = zipSync(files, { level: 6 }),
  name = `energy-lens-${pkg.version}.mcpb`;
await mkdir(new URL("artifacts/", root), { recursive: true });
await writeFile(new URL(`artifacts/${name}`, root), bytes);
await writeFile(
  new URL(`artifacts/${name}.sha256`, root),
  `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`,
);
console.log(
  `Created artifacts/${name} (${Math.round(bytes.length / 1024)} KB). Contains software only; no credentials or meter data.`,
);
