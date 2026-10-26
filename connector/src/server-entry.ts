import { serve } from "./server.js";
serve().catch(() => {
  process.stderr.write(
    "Energy Lens could not start. Check the data directory and tariff configuration.\n",
  );
  process.exitCode = 1;
});
