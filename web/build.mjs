// Builds the web page into web-dist/: one bundled, minified script plus the HTML, CSS, poster and chain logos.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("web-dist", { recursive: true, force: true });
mkdirSync("web-dist");
await build({ entryPoints: ["web/main.ts"], bundle: true, format: "esm", target: "es2022", minify: true, outfile: "web-dist/main.js", legalComments: "none" });
cpSync("web/index.html", "web-dist/index.html");
cpSync("web/style.css", "web-dist/style.css");
cpSync("web/poster.jpg", "web-dist/poster.jpg");
// Chain logos (web3icons, MIT; the licence ships beside them).
cpSync("web/logos", "web-dist/logos", { recursive: true });
// The demo video is not in git: the Pages workflow adds web-dist/demo.mp4 from the v0.1.0 release.
console.log("built web-dist/");
