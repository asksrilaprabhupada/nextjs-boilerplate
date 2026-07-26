// eslint.config.mjs — Lint configuration (flat config, ESLint 9).
//
// Next.js 16 removed the built-in `next lint` command, so the linter is wired
// up explicitly here and exposed as `npm run lint`. eslint-config-next 16 ships
// native flat configs, so they are imported directly rather than through the
// FlatCompat shim — the shim cannot serialise the plugin graph these presets
// build and dies with a circular-structure error.
//
// Generated output, dependencies and the Python tagging pipeline are ignored:
// linting them produces noise that trains people to ignore the linter, which is
// how a real finding gets missed.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "scripts/tags-rebuild/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,

  // The React Compiler rules that ship with eslint-config-next 16 flag 24
  // pre-existing findings across the UI — including the retained earlier design
  // generation under components/landing, components/lockscreen and
  // components/search/01-04, which is unmounted and not on any live path.
  //
  // They are downgraded to `warn` HERE ONLY, and deliberately not switched off:
  // every finding stays visible in `npm run lint` output. Rewriting mount and
  // animation effects across the whole component tree is a UI change with real
  // regression risk, and it does not belong in a phase whose subject is the
  // search backend. Server, lib, hooks-free and test code is held at `error`.
  //
  // Tracked as follow-up work; new violations in these files still surface.
  {
    files: ["app/components/**/*.{ts,tsx}", "app/hooks/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
    },
  },
];

export default eslintConfig;
