import { readFile, writeFile } from "node:fs/promises";
import { build, transform } from "esbuild";

const result = await build({
  entryPoints: ["src/ui/app.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
});
const css = await transform(await readFile("src/ui/styles.css", "utf8"), {
  loader: "css",
  minify: true,
});
const assets = {
  "/": {
    body: await readFile("src/ui/index.html", "utf8"),
    type: "text/html; charset=utf-8",
  },
  "/app.js": {
    body: result.outputFiles[0].text,
    type: "text/javascript; charset=utf-8",
  },
  "/styles.css": { body: css.code, type: "text/css; charset=utf-8" },
};
await writeFile(
  "dist/assets.js",
  `export const assets = ${JSON.stringify(assets)};\n`,
);
