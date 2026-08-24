// Flat config: typescript-eslint recommended over src/, basic rules over tests.
// Kept intentionally close to defaults - the value is the AI-failure-mode net
// (unused vars, floating promises, any-creep), not a style debate.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["test/**/*.mjs", "eslint.config.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["test/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
);
