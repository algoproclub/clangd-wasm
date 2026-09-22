import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const source = resolve(packageRoot, "build/required-wasm-features.wat");
const output = resolve(
  tmpdir(),
  `clangd-wasm-required-features-${process.pid}.wasm`,
);

try {
  execFileSync("wat2wasm", [source, "-o", output], { stdio: "inherit" });
  const bytes = [...readFileSync(output)];
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += 12) {
    lines.push(`  ${bytes.slice(offset, offset + 12).join(", ")},`);
  }
  writeFileSync(
    resolve(packageRoot, "src/required-wasm-features.ts"),
    `// Generated from build/required-wasm-features.wat by npm run generate:support-probe.\n` +
      `// The source names the Wasm instructions being tested; do not edit these bytes.\n` +
      `export const REQUIRED_WASM_FEATURES = new Uint8Array([\n${lines.join("\n")}\n]);\n`,
  );
} finally {
  rmSync(output, { force: true });
}
