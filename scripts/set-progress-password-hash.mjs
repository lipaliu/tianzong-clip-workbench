import { readFile, writeFile } from "node:fs/promises";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const file = args.get("--file");
const hash = args.get("--hash");
if (!file || !hash || !hash.startsWith("$2")) {
  throw new Error("Usage: node set-progress-password-hash.mjs --file <env> --hash <bcrypt-hash>");
}

const original = await readFile(file, "utf8");
const line = `PROGRESS_PASSWORD_HASH=${hash}`;
const updated = /^PROGRESS_PASSWORD_HASH=.*$/m.test(original)
  ? original.replace(/^PROGRESS_PASSWORD_HASH=.*$/m, line)
  : `${original.replace(/\s*$/, "")}\n${line}\n`;
await writeFile(file, updated, { mode: 0o600 });
