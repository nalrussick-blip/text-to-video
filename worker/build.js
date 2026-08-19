// Inlines public/index.html into src/index.js (replacing the placeholder)
// so the Worker can serve the page directly on the free tier without
// needing a separate static-assets setup.
//
// Run this before every `wrangler deploy`:
//   node build.js && wrangler deploy

const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "public/index.html"), "utf8");
const workerSrc = fs.readFileSync(path.join(__dirname, "src/index.template.js"), "utf8");

// Escape backticks/${ so the HTML can live inside a JS template literal safely
const safeHtml = html
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const output = workerSrc.replace("__INDEX_HTML_PLACEHOLDER__", safeHtml);

fs.writeFileSync(path.join(__dirname, "src/index.js"), output);
console.log("Built src/index.js with inlined page (" + html.length + " chars of HTML).");
