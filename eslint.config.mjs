import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { property: "toLocaleLowerCase", message: "Use toLowerCase(): stored values must not depend on the host locale." },
        { property: "toLocaleUpperCase", message: "Use toUpperCase(): stored values must not depend on the host locale." },
      ],
    },
  },
  globalIgnores([".next/**", "coverage/**", "dist/**", "drizzle/meta/**"]),
]);
