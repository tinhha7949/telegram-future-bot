"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.join(__dirname, "..");

function gather(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return gather(file);
    return entry.isFile() && /\.(?:js|cjs)$/.test(entry.name) ? [file] : [];
  });
}

const files = gather(root);
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log("Syntax checked " + files.length + " JavaScript files");
