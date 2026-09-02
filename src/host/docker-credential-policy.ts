/**
 * Shared Docker credential policy.
 *
 * Project files copied into a Docker volume must not carry common secret
 * stores, and a container may receive a host environment value only when its
 * *name* is explicitly allowlisted by the user.
 */
const CREDENTIAL_ALLOWLIST_ENV = "PIWIN_DOCKER_CREDENTIAL_ALLOWLIST";

/** Basename globs understood by GNU tar; `.git` is handled separately. */
export const DOCKER_SECRET_FILE_GLOBS = [
  ".env",
  ".env.*",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
  ".yarnrc",
  ".yarnrc.yml",
  ".aws",
  ".ssh",
  ".gnupg",
  "id_rsa",
  "id_rsa.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "credentials.json",
] as const;

/** Reinstallable artifacts are excluded to keep per-chat snapshots fast. */
export const DOCKER_NON_SOURCE_FILE_GLOBS = [
  "node_modules",
  ".pnpm-store",
  "out",
  "dist",
  ".next",
  ".vite",
  ".turbo",
  "coverage",
] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `"'"'`)}'`;
}

/** Shell fragment that copies a project without VCS internals or credential files. */
export function dockerFilteredWorkspaceCopyCommand(source: string, destination: string): string {
  const excludes = [".git", ...DOCKER_SECRET_FILE_GLOBS, ...DOCKER_NON_SOURCE_FILE_GLOBS]
    .map((pattern) => `--exclude=${shellQuote(pattern)}`)
    .join(" ");
  return `tar -C ${shellQuote(source)} ${excludes} -cf - . | tar -C ${shellQuote(destination)} -xf -`;
}

function isCredentialName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]{0,127}$/.test(value);
}

/** Names are harmless metadata; values never leave the host without approval. */
export function getDockerCredentialAllowlist(): string[] {
  const names = (process.env[CREDENTIAL_ALLOWLIST_ENV] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const invalid = names.filter((name) => !isCredentialName(name));
  if (invalid.length > 0) {
    throw new Error(
      `${CREDENTIAL_ALLOWLIST_ENV} contains invalid environment variable names: ${invalid.join(", ")}.`,
    );
  }
  return [...new Set(names)];
}

export interface DockerCredentialValue {
  name: string;
  value: string;
}

/** Resolve only an explicit, configured subset of host environment values. */
export function resolveDockerCredentialValues(requestedNames: string[]): DockerCredentialValue[] {
  const requested = [...new Set(requestedNames.map((name) => name.trim()).filter(Boolean))];
  const allowed = new Set(getDockerCredentialAllowlist());
  if (requested.length === 0) {
    throw new Error("Choose at least one configured Docker credential name.");
  }
  const unapproved = requested.filter((name) => !allowed.has(name));
  if (unapproved.length > 0) {
    throw new Error(
      `Docker credential names are not allowlisted: ${unapproved.join(", ")}. Add only reviewed names to ${CREDENTIAL_ALLOWLIST_ENV} before launching PiWin.`,
    );
  }
  return requested.map((name) => {
    const value = process.env[name];
    if (!value) throw new Error(`Host environment variable ${name} is not set.`);
    return { name, value };
  });
}
