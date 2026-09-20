import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const cargoToml = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8");
const cargoPackage = cargoToml.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
const cargoVersion = cargoPackage.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const expected = packageJson.version;

const versions = new Map([
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.packages?.[""]?.version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml", cargoVersion],
]);

const mismatches = [...versions].filter(([, version]) => version !== expected);
if (mismatches.length > 0) {
  for (const [file, version] of mismatches) {
    console.error(`${file}: expected ${expected}, found ${version ?? "missing"}`);
  }
  process.exit(1);
}

const releaseTag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
if (releaseTag?.startsWith("v") && releaseTag !== `v${expected}`) {
  console.error(`Release tag ${releaseTag} does not match version v${expected}`);
  process.exit(1);
}

console.log(`Release metadata is consistent at ${expected}${releaseTag ? ` (${releaseTag})` : ""}.`);
