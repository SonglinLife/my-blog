import { readFileSync, writeFileSync } from "node:fs";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseMarkdownFile(filePath) {
  const source = readFileSync(filePath, "utf8");
  const match = source.match(FRONTMATTER_RE);

  if (!match) {
    return {
      source,
      frontmatter: null,
      body: source,
      hasFrontmatter: false,
    };
  }

  return {
    source,
    frontmatter: match[1],
    body: source.slice(match[0].length),
    hasFrontmatter: true,
  };
}

export function writeMarkdownFile(filePath, frontmatter, body) {
  writeFileSync(filePath, `---\n${frontmatter.trim()}\n---\n\n${body.trimStart()}`);
}

export function getScalar(frontmatter, key) {
  if (!frontmatter) return "";
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`, "m"));
  if (!match) return "";
  return unquote(match[1].trim());
}

export function getBoolean(frontmatter, key) {
  const value = getScalar(frontmatter, key).toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function getTags(frontmatter) {
  if (!frontmatter) return [];
  const lines = frontmatter.split(/\r?\n/);
  const inline = frontmatter.match(/^tags:\s*\[(.*)\]\s*$/m);

  if (inline) {
    return inline[1]
      .split(",")
      .map(tag => unquote(tag.trim()))
      .filter(Boolean);
  }

  const tags = [];
  const start = lines.findIndex(line => /^tags:\s*$/.test(line.trim()));
  if (start === -1) return tags;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^[A-Za-z_][\w-]*:\s*/.test(line)) break;

    const match = line.match(/^\s*-\s*(.+?)\s*$/);
    if (match) tags.push(unquote(match[1].trim()));
  }

  return tags.filter(Boolean);
}

export function setScalar(frontmatter, key, value) {
  const formatted = `${key}: ${formatYamlValue(value)}`;
  const re = new RegExp(`^${escapeRegExp(key)}:\\s*.*$`, "m");
  if (re.test(frontmatter)) return frontmatter.replace(re, formatted);
  return `${frontmatter.trimEnd()}\n${formatted}`;
}

export function removeField(frontmatter, key) {
  const lines = frontmatter.split(/\r?\n/);
  const next = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!new RegExp(`^${escapeRegExp(key)}:\\s*`).test(line)) {
      next.push(line);
      continue;
    }

    while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) i++;
  }

  return next.join("\n").trim();
}

export function setTags(frontmatter, tags) {
  const uniqueTags = [...new Set(tags.filter(Boolean))];
  const formatted = ["tags:", ...uniqueTags.map(tag => `  - ${formatYamlValue(tag)}`)];
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex(line => /^tags:\s*/.test(line));

  if (start === -1) return `${frontmatter.trimEnd()}\n${formatted.join("\n")}`;

  let end = start + 1;
  while (end < lines.length) {
    if (/^[A-Za-z_][\w-]*:\s*/.test(lines[end])) break;
    if (lines[end].trim() && !/^\s+-\s*/.test(lines[end]) && !/^\s+/.test(lines[end])) break;
    end++;
  }

  return [...lines.slice(0, start), ...formatted, ...lines.slice(end)].join("\n").trim();
}

export function replaceFrontmatter(source, frontmatter) {
  const match = source.match(FRONTMATTER_RE);
  if (!match) return `---\n${frontmatter.trim()}\n---\n\n${source.trimStart()}`;
  return source.replace(FRONTMATTER_RE, `---\n${frontmatter.trim()}\n---\n\n`);
}

export function formatYamlValue(value) {
  const stringValue = String(value);
  if (/^[A-Za-z0-9_./:+-]+$/.test(stringValue)) return stringValue;
  return JSON.stringify(stringValue);
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
