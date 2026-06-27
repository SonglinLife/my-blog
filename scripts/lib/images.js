import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isSupportedImage, projectRoot, uploadImage } from "./r2.js";

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;

export function collectImageRefs(markdown, markdownFile) {
  const refs = [];
  const markdownDir = dirname(markdownFile);

  for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
    const rawTarget = match[2].trim();
    const target = stripMarkdownTitle(rawTarget);
    refs.push({
      type: "markdown",
      raw: rawTarget,
      url: target,
      alt: match[1].trim(),
      resolvedPath: resolveLocalImage(target, markdownDir),
    });
  }

  for (const match of markdown.matchAll(HTML_IMAGE_RE)) {
    refs.push({
      type: "html",
      raw: match[1].trim(),
      url: match[1].trim(),
      alt: "",
      resolvedPath: resolveLocalImage(match[1].trim(), markdownDir),
    });
  }

  return refs;
}

export function localImageRefs(markdown, markdownFile) {
  return collectImageRefs(markdown, markdownFile).filter(ref => {
    if (!ref.resolvedPath) return false;
    return existsSync(ref.resolvedPath) && isSupportedImage(ref.resolvedPath);
  });
}

export async function rewriteLocalImages(markdownFile, options = {}) {
  const source = readFileSync(markdownFile, "utf8");
  const refs = localImageRefs(source, markdownFile);
  const uploaded = new Map();
  let nextSource = source;

  for (const ref of refs) {
    if (!uploaded.has(ref.resolvedPath)) {
      const url = options.dryRun ? `DRY_RUN:${ref.resolvedPath}` : await uploadImage(ref.resolvedPath);
      uploaded.set(ref.resolvedPath, url);
    }

    const publicUrl = uploaded.get(ref.resolvedPath);
    if (options.dryRun) continue;

    nextSource = replaceImageTarget(nextSource, ref.raw, publicUrl);
  }

  if (!options.dryRun && nextSource !== source) {
    writeFileSync(markdownFile, nextSource);
  }

  return refs.map(ref => ({
    from: ref.url,
    file: ref.resolvedPath,
    to: uploaded.get(ref.resolvedPath),
  }));
}

export function isRemoteImage(url) {
  return /^(https?:)?\/\//i.test(url) || /^data:/i.test(url);
}

function resolveLocalImage(url, markdownDir) {
  if (!url || isRemoteImage(url) || url.startsWith("#")) return null;

  const cleanUrl = decodeURI(url.split(/[?#]/)[0]);
  if (isAbsolute(cleanUrl)) {
    const projectPublicPath = resolve(projectRoot, cleanUrl.slice(1));
    if (existsSync(projectPublicPath)) return projectPublicPath;
    return cleanUrl;
  }

  return resolve(markdownDir, cleanUrl);
}

function stripMarkdownTitle(target) {
  if (target.startsWith("<") && target.includes(">")) {
    return target.slice(1, target.indexOf(">"));
  }

  const titleMatch = target.match(/^(.+?)\s+["'][^"']*["']$/);
  return (titleMatch ? titleMatch[1] : target).trim();
}

function replaceImageTarget(source, rawTarget, publicUrl) {
  const escaped = rawTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.replace(new RegExp(escaped, "g"), publicUrl);
}
