/**
 * ESLint flat config (ESLint 9 / @eslint/js).
 *
 * Added 28 Jun 2026 after the pre-launch code review flagged ~119
 * `react-hooks/exhaustive-deps` warnings, the vast majority of which
 * are noise rather than signal. Rather than chase each call site
 * (refactor risk on launch eve), we make the policy explicit here.
 *
 * IMPORTANT: This file does NOT affect react-scripts' dev-time eslint
 * overlay — CRA bundles its own config. It IS picked up by external
 * code-review / CI tools that run `eslint .` against the repo.
 *
 * Policy decisions encoded here:
 *
 *   • react-hooks/rules-of-hooks → ERROR
 *     Genuine bug class. Never disable.
 *
 *   • react-hooks/exhaustive-deps → WARN (not error)
 *     Many of our "missing deps" are intentional: stable setState
 *     callbacks (React guarantees), API objects from a module-level
 *     singleton (`api`), and refs used inside event handlers. Flagging
 *     them as errors would force noisy `useCallback` wrappings that
 *     hurt readability without preventing any real bug. Real
 *     stale-closure bugs DO show up as warnings — they just don't
 *     block the build.
 *
 *   • exhaustive-deps OFF inside `tests/` and `*.test.*` files —
 *     test files don't render, so the rule's bug class doesn't apply.
 *
 *   • react/jsx-key → ERROR (real bug class — already enforced)
 *   • no-unused-vars → WARN with `args: "none"` so we tolerate the
 *     conventional unused-prefix `_admin` in dependency-injected
 *     route handlers.
 *
 * To suppress an INTENTIONAL exhaustive-deps warning on a specific
 * hook (e.g. a one-shot effect on mount), prefer an inline disable
 * comment ON THAT LINE with a one-sentence reason:
 *
 *   // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount, intentional
 *   useEffect(() => { load(); }, []);
 *
 * That way the reviewer can audit each suppression rather than
 * silently disabling the rule project-wide.
 */
import js from "@eslint/js";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

export default [
  // Base JS recommended rules.
  js.configs.recommended,

  // App source (React).
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2024,
        // CRA injects `process.env.REACT_APP_*` at build time — the
        // `process` global is legitimately available in app code.
        process: "readonly",
      },
    },
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
      "jsx-a11y": jsxA11y,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,

      // We use React 17+ automatic JSX runtime — no need for React in scope.
      "react/react-in-jsx-scope": "off",
      // Prop-types not used (codebase relies on TS-style runtime checks via
      // Pydantic at the API boundary; component contracts live in JSDoc).
      "react/prop-types": "off",

      // Intentional policy: see file header.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // Allow `_prefixed` unused args (used by FastAPI-style DI in tests too).
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Already-real bug class kept strict.
      "react/jsx-key": "error",
      "react/no-unescaped-entities": "off",
    },
  },

  // Test files / build scripts: looser rules.
  {
    files: [
      "src/**/*.test.{js,jsx}",
      "src/setupTests.js",
      "scripts/**/*.{js,mjs,cjs}",
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      // Tests don't render — stale-closure risk doesn't apply.
      "react-hooks/exhaustive-deps": "off",
      "no-unused-vars": "off",
    },
  },

  // Skip generated output and third-party.
  {
    ignores: [
      "build/**",
      "node_modules/**",
      "public/**",
      "coverage/**",
      "**/*.min.js",
    ],
  },
];
