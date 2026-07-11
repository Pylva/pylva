#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const MAP_PATH = path.join(ROOT, 'LICENSE-MAP.md');
const ELASTIC_SPDX = 'SPDX-License-Identifier: Elastic-2.0';
const EL_SECTION = '## Elastic License 2.0 Paths';

function fail(message) {
  console.error(`license-map check failed: ${message}`);
  process.exit(1);
}

function parseElasticGlobs(markdown) {
  const globs = [];
  let inSection = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      inSection = line.trim() === EL_SECTION;
      continue;
    }
    if (!inSection) continue;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      globs.push(match[1]);
    }
  }
  return globs;
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(glob) {
  let source = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i++;
      } else {
        source += '[^/]*';
      }
    } else {
      source += escapeRegex(char);
    }
  }
  source += '$';
  return new RegExp(source);
}

function gitFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return output
    .split('\n')
    .filter(Boolean)
    .filter((file) => {
      try {
        return fs.statSync(path.join(ROOT, file)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function readHead(file, bytes = 8192) {
  const absolute = path.join(ROOT, file);
  const fd = fs.openSync(absolute, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function hasElasticSpdxHeader(file) {
  const lines = readHead(file).split(/\r?\n/);
  const headerIndex = lines[0]?.startsWith('#!') ? 1 : 0;
  return lines[headerIndex]?.includes(ELASTIC_SPDX) ?? false;
}

if (!fs.existsSync(MAP_PATH)) {
  fail('LICENSE-MAP.md is missing');
}

const globs = parseElasticGlobs(fs.readFileSync(MAP_PATH, 'utf8'));
if (globs.length === 0) {
  fail(`no globs found under "${EL_SECTION}"`);
}

const files = gitFiles();
const matchers = globs.map((glob) => ({ glob, regex: globToRegExp(glob) }));
const isMappedElasticFile = (file) => matchers.some(({ regex }) => regex.test(file));

const unmatchedGlobs = matchers
  .map(({ glob, regex }) => ({
    glob,
    count: files.filter((file) => regex.test(file)).length,
  }))
  .filter(({ count }) => count === 0);

const mappedElasticFiles = files.filter(isMappedElasticFile);
const mappedFilesMissingHeader = mappedElasticFiles.filter((file) => !hasElasticSpdxHeader(file));
const elasticHeaderFiles = files.filter((file) => hasElasticSpdxHeader(file));
const headerOutsideMap = elasticHeaderFiles.filter((file) => !isMappedElasticFile(file));
const packageHeaders = elasticHeaderFiles.filter((file) => file.startsWith('packages/'));

const violations = [];
if (unmatchedGlobs.length > 0) {
  violations.push(
    [
      'Globs with no existing file matches:',
      ...unmatchedGlobs.map(({ glob }) => `  - ${glob}`),
    ].join('\n'),
  );
}
if (mappedFilesMissingHeader.length > 0) {
  violations.push(
    [
      'ELv2 mapped files missing Elastic-2.0 SPDX headers:',
      ...mappedFilesMissingHeader.map((file) => `  - ${file}`),
    ].join('\n'),
  );
}
if (headerOutsideMap.length > 0) {
  violations.push(
    [
      'Elastic-2.0 SPDX headers outside LICENSE-MAP.md ELv2 globs:',
      ...headerOutsideMap.map((file) => `  - ${file}`),
    ].join('\n'),
  );
}
if (packageHeaders.length > 0) {
  violations.push(
    [
      'Elastic-2.0 SPDX headers are not allowed under packages/:',
      ...packageHeaders.map((file) => `  - ${file}`),
    ].join('\n'),
  );
}

if (violations.length > 0) {
  console.error(violations.join('\n\n'));
  process.exit(1);
}

console.log('License map check passed.');
console.log(`ELv2 globs: ${globs.length}`);
console.log(`ELv2 mapped files: ${mappedElasticFiles.length}`);
console.log(`Elastic-2.0 SPDX files: ${elasticHeaderFiles.length}`);
