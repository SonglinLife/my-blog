#!/usr/bin/env node
/**
 * Image upload script for Cloudflare R2.
 *
 * Usage:
 *   node scripts/upload-to-r2.js <image1> [image2] ...
 *
 * This is used both by Typora and by AI-agent publishing scripts.
 */
import { uploadImage } from "./lib/r2.js";

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error("No files provided.");
	process.exit(1);
}

const urls = [];

for (const filePath of files) {
	urls.push(await uploadImage(filePath));
}

// Typora expects one URL per line in stdout
console.log(urls.join("\n"));
