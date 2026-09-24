import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Getallen in de UI lopen via ui.tsx, anders negeren ze de knop "Bedragen verbergen" (next build lint mee).
    files: ["src/components/**/*.tsx", "src/app/**/*.tsx"],
    ignores: ["src/components/ui.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/format",
              importNames: ["formatMoney", "formatQuantity", "formatPrice"],
              message: "Getallen in de UI via <Money>/<Qty>/<Price>/<Gain> of useFormat() uit ./ui, zodat 'Bedragen verbergen' ze maskeert.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
