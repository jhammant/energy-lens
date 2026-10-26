import { readFileSync, statSync } from "node:fs";

export type Credentials = { username: string; password: string };
const SERVICE = "energy-lens.glow";
const ENTRY = "default-account";

function secretFile(path: string) {
  if (process.platform !== "win32" && statSync(path).mode & 0o077)
    throw new Error("Credential files must be private (chmod 600).");
  return readFileSync(path, "utf8").trim();
}

export async function getCredentials(): Promise<Credentials> {
  const username = process.env.GLOW_USERNAME?.trim();
  const password = process.env.GLOW_PASSWORD_FILE
    ? secretFile(process.env.GLOW_PASSWORD_FILE)
    : process.env.GLOW_PASSWORD;
  if (username && password) return { username, password };
  if (username || password)
    throw new Error(
      "Supply both Glow username and password in extension settings, or run energy-lens login.",
    );
  try {
    const { Entry } = await import("@napi-rs/keyring");
    const value = new Entry(SERVICE, ENTRY, {
      linux: { store: "secret-service" },
    }).getPassword();
    if (value) {
      const credentials = JSON.parse(value);
      if (
        typeof credentials.username === "string" &&
        typeof credentials.password === "string"
      )
        return credentials;
    }
  } catch {
    /* The actionable error below does not disclose keychain contents. */
  }
  throw new Error(
    "Connect Glow in the extension settings or run energy-lens login. Your meter must first be verified in Bright/Glow. CSV imports work without login.",
  );
}

export async function saveCredentials(credentials: Credentials) {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    new Entry(SERVICE, ENTRY, {
      linux: { store: "secret-service" },
    }).setPassword(JSON.stringify(credentials));
  } catch {
    throw new Error(
      "The OS credential store is unavailable. Use extension secure settings or GLOW_USERNAME with GLOW_PASSWORD_FILE; no password was saved to disk.",
    );
  }
}

export async function deleteCredentials() {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    new Entry(SERVICE, ENTRY, {
      linux: { store: "secret-service" },
    }).deletePassword();
  } catch {
    throw new Error(
      "Could not remove the saved account from the OS credential store.",
    );
  }
}
