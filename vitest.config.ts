import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: { reporter: ["text", "json", "html"] },
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
