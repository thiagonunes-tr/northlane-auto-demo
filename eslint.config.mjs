import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // core-web-vitals enables only 6 jsx-a11y rules. Take the recommended rule
  // set without re-registering the plugin, which eslint-config-next already
  // provides. This catches the class of defect the design audit found by hand.
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    rules: jsxA11y.flatConfigs.recommended.rules,
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "vercel-frontend/dist/**",
    "vercel-frontend/node_modules/**",
    "next-env.d.ts",
    // The Playwright virtualenv (see .gitignore) ships bundled JavaScript.
    ".venv-e2e/**",
  ]),
]);

export default eslintConfig;
