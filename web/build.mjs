// Builds the web page into web-dist/: one bundled, minified script plus the HTML and CSS. No other files ship.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("web-dist", { recursive: true, force: true });
mkdirSync("web-dist");
await build({ entryPoints: ["web/main.ts"], bundle: true, format: "esm", target: "es2022", minify: true, outfile: "web-dist/main.js", legalComments: "none" });
cpSync("web/index.html", "web-dist/index.html");
cpSync("web/style.css", "web-dist/style.css");
console.log("built web-dist/");
