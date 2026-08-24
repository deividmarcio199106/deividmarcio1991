import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
            {
              name: "ai",
              message:
                "Use o AI Gateway (@/services/ai): ele centraliza timeout, circuit breaker e sanitização de erro.",
            },
          ],
          // O AI Gateway (src/services/ai) é o ÚNICO ponto que fala com IA.
          // Importar o SDK direto contornaria o circuit breaker, o timeout e a
          // limpeza de URLs das mensagens de erro — e poderia vazar o endereço
          // da GPU para o bundle do navegador.
          patterns: [
            {
              group: ["@ai-sdk/*"],
              message:
                "Use o AI Gateway (@/services/ai): ele centraliza timeout, circuit breaker e sanitização de erro.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // O próprio gateway precisa importar o SDK — restaura a regra sem o padrão.
    files: ["src/services/ai/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
    },
  },
  {
    // Componentes-base do design system exportam variantes junto do componente.
    files: ["src/components/ui/**/*.tsx"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  eslintPluginPrettier,
);
