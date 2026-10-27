// Builds the web page into web-dist/: a bundled, minified script per page plus the two pages, CSS, poster, header art, chain logos and icons.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("web-dist", { recursive: true, force: true });
mkdirSync("web-dist");
await build({ entryPoints: ["web/main.ts", "web/address.ts"], bundle: true, format: "esm", target: "es2022", minify: true, outdir: "web-dist", legalComments: "none" });
cpSync("web/index.html", "web-dist/index.html");
cpSync("web/address.html", "web-dist/address.html");
cpSync("web/style.css", "web-dist/style.css");
cpSync("web/poster.jpg", "web-dist/poster.jpg");
cpSync("web/refund.jpg", "web-dist/refund.jpg");
// Chain logos (web3icons, MIT; the licence ships beside them).
cpSync("web/logos", "web-dist/logos", { recursive: true });
// The Cryppit favicon and home-screen icon.
cpSync("web/icons", "web-dist/icons", { recursive: true });
// The demo video is not in git: the Pages workflow adds web-dist/demo.mp4 from the v0.1.0 release.
console.log("built web-dist/");
