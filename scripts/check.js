// Repository self-check: JavaScript syntax, required files, and asset links.
// Run: npm run check

"use strict"

const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const root = path.join(__dirname, "..")
const ignore = new Set(["node_modules", "data", ".git", "coverage"])
const required = [
  "package.json",
  "src/server.js",
  "src/config.js",
  "src/schedule.js",
  "src/holidays.js",
  "src/holiday-service.js",
  "src/balance.js",
  "src/balance-service.js",
  "src/status.js",
  "public/index.html",
  "public/widget.css",
  "public/widget-core.js",
  "public/widget.js",
  "public/deepseek.svg",
  "public/favicon.svg",
  "public/fonts/JetBrainsMono-Regular.woff2",
  "public/fonts/OFL.txt",
  "glance/deepseek.yml",
  "glance/full-glance.yml",
  "glance/custom-api.yml",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.glance.yml",
  "LICENSE",
  "NOTICE"
]

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignore.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else files.push(full)
  }
  return files
}

function main() {
  let failures = 0

  for (const relative of required) {
    if (!fs.existsSync(path.join(root, relative))) {
      console.error("missing: " + relative)
      failures++
    }
  }

  const jsFiles = walk(root, []).filter((file) => file.endsWith(".js"))
  for (const file of jsFiles) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" })
    if (result.status !== 0) {
      console.error("syntax: " + path.relative(root, file))
      if (result.stderr) console.error(result.stderr.trim())
      failures++
    }
  }

  const htmlFile = path.join(root, "public/index.html")
  if (fs.existsSync(htmlFile)) {
    const html = fs.readFileSync(htmlFile, "utf8")
    const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1])
    for (const reference of references) {
      if (!reference || reference.startsWith("#") || /^[a-z]+:/i.test(reference)) continue
      const clean = reference.split(/[?#]/)[0]
      if (!clean) continue
      const target = clean.startsWith("/")
        ? path.join(root, "public", clean.slice(1))
        : path.join(root, "public", clean)
      if (!fs.existsSync(target)) {
        console.error("broken asset reference: " + reference)
        failures++
      }
    }
  }

  if (failures > 0) {
    console.error("\ncheck failed: " + failures + " problem(s)")
    process.exitCode = 1
    return
  }
  console.log("check: " + jsFiles.length + " JavaScript files and " + required.length + " required files OK")
}

main()
