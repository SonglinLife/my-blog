#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { projectRoot } from "./lib/r2.js";

const findings = [];
const projectRootPattern = escapeRegExp(projectRoot);

checkPackageManager();
checkPagefindVersion();
checkSensitiveContent();
checkDraftArtifacts();

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.level.toUpperCase()} ${finding.message}`);
  }
}

if (findings.some(finding => finding.level === "error")) process.exit(1);
console.log("Guardrails passed.");

function checkPackageManager() {
  const forbiddenFiles = ["pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock"];
  for (const file of forbiddenFiles) {
    if (existsSync(resolve(projectRoot, file))) {
      add("error", `${file} exists. This repo uses npm/package-lock; do not switch package managers.`);
    }
  }
}

function checkPagefindVersion() {
  const packageVersion = readJson(resolve(projectRoot, "package-lock.json"))?.packages?.["node_modules/pagefind"]?.version;
  const entryPath = resolve(projectRoot, "public/pagefind/pagefind-entry.json");
  const generatedVersion = readJson(entryPath)?.version;

  if (!packageVersion || !generatedVersion) return;
  if (packageVersion !== generatedVersion) {
    add(
      "error",
      `Pagefind generated assets are version ${generatedVersion}, but package-lock has ${packageVersion}. Run npm ci, then regenerate with npm run build.`
    );
  }
}

function checkSensitiveContent() {
  const tracked = git(["ls-files"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  const targets = [...tracked, ...untracked].filter(file => {
    if (!file) return false;
    if (file.startsWith("node_modules/") || file.startsWith("dist/")) return false;
    if (file === ".env" || file === "env") return false;
    return /\.(md|mdx|astro|ts|js|json|yml|yaml|txt)$/i.test(file);
  });

  const patterns = [
    {
      name: "full Google verification token",
      re: /google-site-verification=(?!\.\.\.)[A-Za-z0-9_-]{20,}/,
    },
    {
      name: "local absolute path",
      re: new RegExp(`${projectRootPattern}|/Users/[^\\s)'"]+|/home/[^\\s)'"]+|/var/folders/[^\\s)'"]+|/tmp/[^\\s)'"]+|[A-Za-z]:\\\\[^\\s)'"]+`),
    },
    {
      name: "private environment variable value",
      re: /(CLOUDFLARE_API_TOKEN|R2_SECRET_ACCESS_KEY|R2_ACCESS_KEY_ID)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{10,}/,
    },
  ];

  for (const file of targets) {
    const content = readFile(resolve(projectRoot, file));
    if (content == null) continue;

    for (const pattern of patterns) {
      if (pattern.re.test(content)) {
        add("error", `${file} contains ${pattern.name}. Remove or redact it before committing.`);
      }
    }
  }
}

function checkDraftArtifacts() {
  const artifacts = ["learn-tech_outputs", "draft-assets", ".blog-drafts"];
  for (const artifact of artifacts) {
    if (!existsSync(resolve(projectRoot, artifact))) continue;
    const ignored = git(["check-ignore", artifact], { allowFailure: true }).trim();
    if (!ignored) {
      add("error", `${artifact}/ exists but is not ignored by git.`);
    }
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readFile(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function git(args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", options.allowFailure ? "ignore" : "pipe"],
    });
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
}

function add(level, message) {
  findings.push({ level, message });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
