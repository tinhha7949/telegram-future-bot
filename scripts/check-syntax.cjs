"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { execFileSync } = require("node:child_process");
const root = path.join(__dirname, "..");
const files = [
  "index.js",
  ...fs
    .readdirSync(path.join(root, "ai-trading"))
    .filter((f) => /\.(?:js|cjs)$/.test(f))
    .map((f) => path.join("ai-trading", f)),
];
for (const file of files)
  execFileSync(process.execPath, ["--check", path.join(root, file)], {
    stdio: "inherit",
  });
console.log(`Syntax checked ${files.length} files`);
