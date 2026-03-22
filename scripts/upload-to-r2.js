#!/usr/bin/env node
/**
 * Typora Image Upload Script for Cloudflare R2
 *
 * Usage: node upload-to-r2.js <image1> [image2] [image3] ...
 *
 * Typora config:
 *   Preferences → Image → Upload Service → Custom Command
 *   Command: node /Users/wu/wsl/my-blog/scripts/upload-to-r2.js
 *
 * Reads R2 credentials from .env in project root.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load .env from project root
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
try {
	const envContent = readFileSync(envPath, 'utf-8');
	for (const line of envContent.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIndex = trimmed.indexOf('=');
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		const value = trimmed.slice(eqIndex + 1).trim();
		if (!process.env[key]) process.env[key] = value;
	}
} catch {}

const {
	R2_ACCOUNT_ID,
	R2_ACCESS_KEY_ID,
	R2_SECRET_ACCESS_KEY,
	R2_BUCKET_NAME,
	R2_PUBLIC_URL,
} = process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
	console.error('Missing required environment variables. Need: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL');
	process.exit(1);
}

const s3 = new S3Client({
	region: 'auto',
	endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId: R2_ACCESS_KEY_ID,
		secretAccessKey: R2_SECRET_ACCESS_KEY,
	},
});

const MIME_TYPES = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.bmp': 'image/bmp',
	'.ico': 'image/x-icon',
};

const files = process.argv.slice(2);
if (files.length === 0) {
	console.error('No files provided.');
	process.exit(1);
}

const urls = [];

for (const filePath of files) {
	const ext = extname(filePath).toLowerCase();
	const contentType = MIME_TYPES[ext] || 'application/octet-stream';
	const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
	const key = `blog/${datePrefix}/${randomUUID()}${ext}`;

	const body = readFileSync(filePath);

	await s3.send(new PutObjectCommand({
		Bucket: R2_BUCKET_NAME,
		Key: key,
		Body: body,
		ContentType: contentType,
	}));

	const publicUrl = `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
	urls.push(publicUrl);
}

// Typora expects one URL per line in stdout
console.log(urls.join('\n'));
