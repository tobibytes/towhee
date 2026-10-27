import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  clean: true,
  target: "node22",
  platform: "node",
  // tsup strips "node:" by default, which breaks node:sqlite: it only exists under that name.
  removeNodeProtocol: false,
});
