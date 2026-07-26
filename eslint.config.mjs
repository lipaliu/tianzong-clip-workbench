import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".vinext/**",
    "dist/**",
    "out/**",
    "build/**",
    // The media processor is a separate Node/TypeScript package with its own
    // strict typecheck and test suite.
    "processor/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
