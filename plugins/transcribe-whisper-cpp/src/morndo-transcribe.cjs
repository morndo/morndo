#!/usr/bin/env node
// Extensionless once installed, so Node treats this file as CommonJS. The implementation is .mts,
// which stays an ES module the way .mjs does (Node.js TypeScript support: .mts mirrors .mjs).
// A nearby package.json "type": "module" would make this extensionless file ESM too, and require
// would fail, so the implementation keeps the .mts name and this file stays CommonJS.
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// argv[1] stays the symlink path. __dirname is this file's real directory, so the .mts and the
// install root (plugin.json, whisper-cli, the model) resolve when the executable is a symlink.
const here = __dirname;
import(pathToFileURL(path.join(here, "morndo-transcribe.mts")).href)
  .then((mod) => mod.main(process.argv.slice(2), here))
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
