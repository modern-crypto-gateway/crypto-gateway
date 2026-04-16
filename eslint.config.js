// @ts-check
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import importPlugin from "eslint-plugin-import";

// Globals we never want leaking into portable code.
// Entrypoints and specific adapters are allowed to reference their native runtime;
// everything else (especially core/**) must stay neutral.
const PLATFORM_GLOBALS = [
  { name: "process", message: "Use deps.secrets (SecretsProvider) or read env only in entrypoints/node.ts and adapters/secrets/process-env.ts." },
  { name: "Deno", message: "Read Deno.env only in entrypoints/deno.ts and adapters/secrets/deno-env.ts." },
  { name: "Bun", message: "Bun globals are not portable. Use deps.* instead." },
  { name: "__dirname", message: "Not available on Workers/Deno. Use import.meta.url if you truly need a path." },
  { name: "__filename", message: "Not available on Workers/Deno. Use import.meta.url if you truly need a path." },
  { name: "require", message: "Use ESM import. CommonJS require is not available in Workers/Deno." }
];

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "**/*.d.ts"]
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: false
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      import: importPlugin
    },
    // `import/no-restricted-paths` only inspects the literal import specifier
    // (path prefixes), so we don't need a TS resolver. Avoiding the extra
    // `eslint-import-resolver-typescript` dependency.
    rules: {
      // ---- Portability: ban platform globals project-wide by default ----
      "no-restricted-globals": ["error", ...PLATFORM_GLOBALS],

      // ---- Layering: core cannot depend on adapters or entrypoints ----
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./src/core",
              from: "./src/adapters",
              message: "core/** must not import from adapters/**. Depend on a port interface in core/ports/** instead."
            },
            {
              target: "./src/core",
              from: "./src/entrypoints",
              message: "core/** must not import from entrypoints/**."
            },
            {
              target: "./src/core",
              from: "./src/http",
              message: "core/** must not import from http/**."
            },
            {
              target: "./src/adapters",
              from: "./src/entrypoints",
              message: "adapters/** must not import from entrypoints/**."
            },
            {
              target: "./src/adapters",
              from: "./src/http",
              message: "adapters/** must not import from http/**."
            }
          ]
        }
      ],

      // ---- Typescript hygiene ----
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }]
    }
  },

  // ---- Narrow exceptions where a platform global is legitimately needed ----
  {
    files: [
      "src/entrypoints/node.ts",
      "src/adapters/secrets/process-env.ts",
      "src/adapters/jobs/promise-set.adapter.ts"
    ],
    rules: {
      "no-restricted-globals": ["error", ...PLATFORM_GLOBALS.filter((g) => g.name !== "process")]
    }
  },
  {
    files: ["src/entrypoints/deno.ts", "src/adapters/secrets/deno-env.ts"],
    rules: {
      "no-restricted-globals": ["error", ...PLATFORM_GLOBALS.filter((g) => g.name !== "Deno")]
    }
  },

  // ---- Tests: relax a few rules that don't serve testing ----
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off"
    }
  }
];
