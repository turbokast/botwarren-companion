#!/usr/bin/env node
/**
 * Extracts the release notes for one version from CHANGELOG.md (Keep a Changelog format) and prints them as Markdown.
 * Used by .github/workflows/release.yml so the GitHub Release body is the reviewed changelog entry, not generated text.
 *
 *   node apps/companion/scripts/changelog-notes.mjs <version> [--changelog CHANGELOG.md] [--out <file>]
 *
 * Fails (exit 1) when the version has no section, the section has no date, or it is empty: a release needs a written changelog entry,
 * and failing closed here stops the release before anything is published. Licence: Apache-2.0.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} text the whole CHANGELOG.md
 * @param {string} version for example "0.1.0" (no leading v)
 * @returns {{ date: string, body: string }}
 */
export function extractNotes(text, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const head = new RegExp(`^## \\[${escapeRe(version)}\\](?: - (\\d{4}-\\d{2}-\\d{2}))?\\s*$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) throw new Error(`CHANGELOG.md has no section "## [${version}] - YYYY-MM-DD"`);
  const date = head.exec(lines[start])[1];
  if (!date) throw new Error(`the CHANGELOG.md section for ${version} has no release date`);
  let end = lines.findIndex((l, i) => i > start && (/^## /.test(l) || /^\[[^\]]+\]:\s+\S+/.test(l)));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!/\S/.test(body.replace(/^###.*$/gm, ''))) throw new Error(`the CHANGELOG.md section for ${version} is empty`);
  return { date, body };
}

function main(argv) {
  const [version, ...rest] = argv;
  if (!version) { console.error('usage: changelog-notes.mjs <version> [--changelog <file>] [--out <file>]'); process.exit(2); }
  const opt = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
  try {
    const { body } = extractNotes(readFileSync(opt('--changelog', 'CHANGELOG.md'), 'utf8'), version);
    const out = `${body}\n\n---\n\nVerify what you download: see [Verify a release](https://github.com/turbokast/botwarren-companion/blob/v${version}/docs/RELEASING.md#verifying-a-release). The relay image inputs (\`relay-context-${version}.tar.gz\`) hold the signed web client. Full history: [CHANGELOG.md](https://github.com/turbokast/botwarren-companion/blob/v${version}/CHANGELOG.md).\n`;
    const file = opt('--out');
    if (file) writeFileSync(file, out); else process.stdout.write(out);
  } catch (e) {
    console.error(`changelog-notes: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
