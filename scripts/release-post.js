#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { projectRoot } from "./lib/r2.js";

const args = parseArgs(process.argv.slice(2));
const post = args._[0];

if (!post) {
  console.error("Usage: node scripts/release-post.js src/data/blog/post.md [--message \"commit message\"] [--no-push]");
  process.exit(1);
}

const postPath = resolve(projectRoot, post);
if (!existsSync(postPath)) {
  console.error(`Post not found: ${post}`);
  process.exit(1);
}

const commitMessage = args.message || `Publish ${basename(post, ".md")}`;
const shouldPush = !args.noPush;
const branch = git(["branch", "--show-current"]).trim();

if (!branch) {
  console.error("Cannot determine current git branch.");
  process.exit(1);
}

run("npm", ["run", "post:publish", "--", post]);
run("npm", ["run", "post:check", "--", post]);
run("npm", ["run", "post:guardrails"]);
run("npm", ["run", "build"]);

run("git", ["add", "-A"]);

if (!hasStagedChanges()) {
  console.log("No changes to commit.");
  process.exit(0);
}

run("git", ["commit", "-m", commitMessage]);

if (shouldPush) {
  run("git", ["push", "origin", branch]);
}

console.log(`Released ${post}`);
console.log(`Branch: ${branch}`);
if (shouldPush) console.log("Pushed: yes");

function parseArgs(argv) {
  const parsed = { _: [], noPush: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-push") {
      parsed.noPush = true;
      continue;
    }
    if (arg === "--message" || arg === "-m") {
      parsed.message = argv[++i];
      continue;
    }
    parsed._.push(arg);
  }

  return parsed;
}

function run(command, args) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

function git(args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hasStagedChanges() {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    return false;
  } catch (error) {
    if (error.status === 1) return true;
    throw error;
  }
}
