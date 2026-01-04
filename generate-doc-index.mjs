import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const CHECK_MODE = process.argv.includes('--check');

const SECTION_START = '<!-- AUTO-GENERATED:MODULE-INDEX:START -->';
const SECTION_END = '<!-- AUTO-GENERATED:MODULE-INDEX:END -->';

const PLUGIN_INDEX_SECTION_START = '<!-- AUTO-GENERATED:PLUGIN-INDEX:START -->';
const PLUGIN_INDEX_SECTION_END = '<!-- AUTO-GENERATED:PLUGIN-INDEX:END -->';

const ADMIN_PLUGIN_READMES_PATH = 'admin/plugin-readmes.json';

const require = createRequire(import.meta.url);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listDirFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}

async function listDirNames(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

function makeModuleStubDoc({ title, implementationPath }) {
  return `# ${title} (Message Hub): TODO short summary

\`${title}\` TODO: add a 2–4 sentence description of what this module does and why it exists.

---

## Where it sits in the system

TODO: Describe who calls this module and what it calls downstream.

---

## Core responsibilities

TODO:

1. TODO
2. TODO
3. TODO

---

## Public API (what you typically use)

TODO: List the main exported class/functions and what they do.

### TODO: \`someMethod(...)\`

TODO: Describe inputs/outputs and important behavior.

---

## Design guidelines / invariants (the important rules)

TODO:

### 1) TODO

TODO

---

## Related files

- Implementation: \`${implementationPath}\`
- Module overview: \`docs/modules/README.md\`
`;
}

function makePluginStubDoc({ title, implementationPath }) {
  return `# TODO <Producer || Notifier || Bridge>: ${title}

TODO: Add 2–4 sentence summary: what it does, where it hooks in (Ingest/Notify), and why it exists.

This document has two parts:

1) A user-facing guide (setup, configuration, best practices).
2) A technical description (how it works internally).

---

## 1) User Guide

### What it does

- TODO: a
- TODO: b

What it intentionally does not do:

- TODO: a
- TODO: b

### Prerequisites

- TODO: a
- TODO: b

### Quick start (recommended setup)

1. TODO
2. TODO

### How to configure

Configuration is done in the Message Hub Admin Tab (Plugins) and uses the schema from \`lib/<TODO>/manifest.js\`.

TODO: describe Options/parameters here
  
### Troubleshooting

---

## 2) Software Documentation

### Overview

- TODO
  
Implementation:

- TODO
  

### Runtime wiring (IoPlugins)

TODO

### Event handling

- TODO

### TODO add other relevant Topics

---

## Related files

- Implementation: TODO
- Manifest: TODO
- Dispatcher: TODO
- Plugin overview: \`docs/plugins/README.md\`

`;
}

function buildIndexLines(mdFiles) {
  const sorted = [...mdFiles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.map((filename) => {
    const base = path.basename(filename, '.md');
    return `- \`${base}\`: [\`./${filename}\`](./${filename})`;
  });
}

function replaceOrAppendModuleSection(readmeText, indexLines) {
  const text = normalizeNewlines(readmeText);

  const hasMarkers = text.includes(SECTION_START) && text.includes(SECTION_END);
  if (hasMarkers) {
    const startIndex = text.indexOf(SECTION_START);
    const endIndex = text.indexOf(SECTION_END);
    const before = text.slice(0, startIndex);
    const after = text.slice(endIndex + SECTION_END.length);
    const middle = `${SECTION_START}\n${indexLines.join('\n')}\n${SECTION_END}`;
    return `${before}${middle}${after}`.replace(/\n{3,}/g, '\n\n');
  }

  const lines = text.split('\n');
  const headingMatchers = [
    /^##\s+Module\s*$/i,
    /^##\s+Modules\s*$/i,
    /^##\s+Detail-Dokumente\b.*$/i,
  ];

  let headingIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headingMatchers.some((re) => re.test(lines[i]))) {
      headingIndex = i;
      break;
    }
  }

  const newSection = [
    '## Modules',
    '',
    SECTION_START,
    ...indexLines,
    SECTION_END,
    '',
  ];

  if (headingIndex === -1) {
    return `${text.replace(/\s+$/, '')}\n\n${newSection.join('\n')}\n`;
  }

  let nextHeadingIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      nextHeadingIndex = i;
      break;
    }
  }

  const updated = [
    ...lines.slice(0, headingIndex),
    ...newSection,
    ...lines.slice(nextHeadingIndex),
  ];
  return `${updated.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
}

function replaceSection({ text, startMarker, endMarker, newContent }) {
  const normalized = normalizeNewlines(text);
  if (!normalized.includes(startMarker) || !normalized.includes(endMarker)) {
    throw new Error(`Missing required markers: ${startMarker} / ${endMarker}`);
  }

  const startIndex = normalized.indexOf(startMarker);
  const endIndex = normalized.indexOf(endMarker);
  const before = normalized.slice(0, startIndex);
  const after = normalized.slice(endIndex + endMarker.length);
  const middle = `${startMarker}\n${newContent}\n${endMarker}`;
  return `${before}${middle}${after}`.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

function inferPluginFamily(type) {
  const t = String(type || '').trim();
  if (t.startsWith('Ingest')) return 'Ingest';
  if (t.startsWith('Notify')) return 'Notify';
  if (t.startsWith('Bridge')) return 'Bridge';
  if (t.startsWith('Engage')) return 'Engage';
  return 'Other';
}

function toSingleLine(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeMarkdownTableCell(value) {
  return String(value || '')
    .replace(/\|/g, '\\|')
    .trim();
}

async function loadPluginManifests({ pluginsDir }) {
  const pluginDirs = (await listDirNames(pluginsDir))
    .filter((d) => !d.startsWith('.') && !d.startsWith('_'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const entries = [];
  for (const dir of pluginDirs) {
    const manifestPath = path.join(pluginsDir, dir, 'manifest.js');
    if (!(await exists(manifestPath))) continue;

    let loaded;
    try {
      loaded = require(path.resolve(manifestPath));
    } catch (e) {
      throw new Error(`Failed to load plugin manifest: ${manifestPath} (${e?.message || e})`);
    }

    const manifest = loaded?.manifest;
    if (!manifest || typeof manifest !== 'object') {
      throw new Error(`Invalid plugin manifest export: ${manifestPath} (expected module.exports.manifest)`);
    }

    if (manifest.hidden === true || manifest.discoverable === false) {
      continue;
    }

    const type = manifest.type;
    if (typeof type !== 'string' || !type.trim()) {
      throw new Error(`Invalid plugin manifest type: ${manifestPath} (expected manifest.type string)`);
    }

    entries.push({
      dir,
      type: type.trim(),
      family: inferPluginFamily(type),
      defaultEnabled: !!manifest.defaultEnabled,
      supportsMultiple: !!manifest.supportsMultiple,
      purpose: toSingleLine(manifest?.description?.en || manifest?.description?.de || ''),
      title: manifest?.title || null,
    });
  }

  return entries.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

function buildPluginIndexTable(pluginEntries) {
  const header = [
    '| Type | Family | Purpose (short) | defaultEnabled | supportsMultiple | Docs |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  const rows = pluginEntries.map((p) => {
    const docs = `[\`./${p.type}.md\`](./${p.type}.md)`;
    const purpose = escapeMarkdownTableCell(p.purpose || '');
    return `| \`${p.type}\` | ${p.family} | ${purpose} | \`${p.defaultEnabled}\` | \`${p.supportsMultiple}\` | ${docs} |`;
  });

  return [...header, ...rows].join('\n');
}

async function updatePluginIndex({ pluginsDir, pluginIndexPath }) {
  const pluginEntries = await loadPluginManifests({ pluginsDir });
  const table = buildPluginIndexTable(pluginEntries);

  const current = normalizeNewlines(await fs.readFile(pluginIndexPath, 'utf8'));
  const next = replaceSection({
    text: current,
    startMarker: PLUGIN_INDEX_SECTION_START,
    endMarker: PLUGIN_INDEX_SECTION_END,
    newContent: table,
  });

  if (current !== next) {
    if (CHECK_MODE) return { changed: true };
    await fs.writeFile(pluginIndexPath, next, 'utf8');
  }

  return { changed: false };
}

function extractUserGuideMarkdown(md) {
  const text = normalizeNewlines(String(md || ''));
  const lines = text.split('\n');

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s*1\)\s*User\s+Guide\b/i.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return '';

  while (start < lines.length && !lines[start].trim()) start += 1;

  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s*2\)\s*/i.test(lines[i])) {
      end = i;
      break;
    }
  }

  const out = lines.slice(start, end).join('\n').trim();
  return out;
}

async function updateAdminPluginReadmes({ pluginsDir, docsDir, outPath }) {
  const pluginEntries = await loadPluginManifests({ pluginsDir });

  /** @type {Record<string, { md: string, source: string }>} */
  const byType = {};

  for (const p of pluginEntries) {
    const docPath = path.join(docsDir, `${p.dir}.md`);
    if (!(await exists(docPath))) {
      continue;
    }
    const md = normalizeNewlines(await fs.readFile(docPath, 'utf8'));
    const userGuide = extractUserGuideMarkdown(md);
    if (!userGuide) {
      continue;
    }
    byType[p.type] = { md: userGuide, source: docPath.replace(/\\/g, '/') };
  }

  const sorted = Object.fromEntries(
    Object.entries(byType).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const next = `${JSON.stringify(sorted, null, 2)}\n`;

  const current = (await exists(outPath)) ? normalizeNewlines(await fs.readFile(outPath, 'utf8')) : '';
  if (current !== next) {
    if (CHECK_MODE) return { changed: true };
    await fs.writeFile(outPath, next, 'utf8');
  }
  return { changed: false };
}

async function ensureDocsForJsFiles({ jsDir, docsDir }) {
  const jsFilenames = (await listDirFiles(jsDir))
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'index.js')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const missingDocs = [];

  for (const jsFilename of jsFilenames) {
    const base = path.basename(jsFilename, '.js');
    const docFilename = `${base}.md`;
    const docPath = path.join(docsDir, docFilename);

    if (await exists(docPath)) continue;

    if (CHECK_MODE) {
      missingDocs.push(docPath);
      continue;
    }

    const implementationPath = `${jsDir}/${jsFilename}`;
    const stub =
      jsDir === 'src'
        ? makeModuleStubDoc({ title: base, implementationPath })
        : makePluginStubDoc({ title: base, implementationPath });
    await fs.writeFile(docPath, stub, 'utf8');
  }

  return { missingDocs };
}

async function ensureDocsForPluginEntries({ pluginsDir, docsDir }) {
  // Convention: plugin entry points live at `lib/<PluginName>/index.js`.
  // This avoids false positives from helper files in lib/ and guarantees 1 doc per plugin.
  const pluginDirs = (await listDirNames(pluginsDir))
    .filter((d) => !d.startsWith('.') && !d.startsWith('_'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const missingDocs = [];

  for (const dir of pluginDirs) {
    const entryPath = path.join(pluginsDir, dir, 'index.js');
    if (!(await exists(entryPath))) {
      continue;
    }

    const docFilename = `${dir}.md`;
    const docPath = path.join(docsDir, docFilename);

    if (await exists(docPath)) {
      continue;
    }

    if (CHECK_MODE) {
      missingDocs.push(docPath);
      continue;
    }

    const implementationPath = `${pluginsDir}/${dir}/index.js`;
    const stub = makePluginStubDoc({ title: dir, implementationPath });
    await fs.writeFile(docPath, stub, 'utf8');
  }

  return { missingDocs };
}

async function updateReadmeIndex({ docsDir, readmePath, excludeDocFilenames = [] }) {
  const exclude = new Set(excludeDocFilenames.map((f) => f.toLowerCase()));
  const mdFiles = (await listDirFiles(docsDir)).filter((f) => {
    if (!f.endsWith('.md')) return false;
    if (f.toLowerCase() === 'readme.md') return false;
    if (exclude.has(f.toLowerCase())) return false;
    return true;
  });
  const indexLines = buildIndexLines(mdFiles);

  const current = normalizeNewlines(await fs.readFile(readmePath, 'utf8'));
  const next = replaceOrAppendModuleSection(current, indexLines);

  if (current !== next) {
    if (CHECK_MODE) return { changed: true };
    await fs.writeFile(readmePath, next, 'utf8');
  }

  return { changed: false };
}

async function scanTodoPlaceholders({ docsDir }) {
  const mdFiles = (await listDirFiles(docsDir)).filter(
    (f) => f.toLowerCase() !== 'readme.md' && f.endsWith('.md'),
  );

  const todoByFile = [];
  for (const filename of mdFiles) {
    const filePath = path.join(docsDir, filename);
    const text = normalizeNewlines(await fs.readFile(filePath, 'utf8'));
    const matches = text.match(/\bTODO\b\s*:/g);
    if (matches?.length) todoByFile.push({ filePath, count: matches.length });
  }

  return todoByFile.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
}

async function main() {
  const results = [];

  const modules = await ensureDocsForJsFiles({
    jsDir: 'src',
    docsDir: 'docs/modules',
  });
  results.push({ kind: 'modules', ...modules });

  const plugins = await ensureDocsForPluginEntries({
    pluginsDir: 'lib',
    docsDir: 'docs/plugins',
  });
  results.push({ kind: 'plugins', ...plugins });

  const pluginIndex = await updatePluginIndex({
    pluginsDir: 'lib',
    pluginIndexPath: 'docs/plugins/PLUGIN-INDEX.md',
  });

  const adminPluginReadmes = await updateAdminPluginReadmes({
    pluginsDir: 'lib',
    docsDir: 'docs/plugins',
    outPath: ADMIN_PLUGIN_READMES_PATH,
  });

  const readmes = [
    { kind: 'modules', docsDir: 'docs/modules', readmePath: 'docs/modules/README.md' },
    {
      kind: 'plugins',
      docsDir: 'docs/plugins',
      readmePath: 'docs/plugins/README.md',
      excludeDocFilenames: ['index.md'],
    },
  ];

  const changedReadmes = [];
  for (const r of readmes) {
    const res = await updateReadmeIndex(r);
    if (res.changed) changedReadmes.push(r.readmePath);
  }

  const missingDocs = results.flatMap((r) => r.missingDocs);

  if (CHECK_MODE) {
    const todoWarnings = [
      ...(await scanTodoPlaceholders({ docsDir: 'docs/modules' })),
      ...(await scanTodoPlaceholders({ docsDir: 'docs/plugins' })),
    ];

    if (todoWarnings.length) {
      // GitHub Actions annotation format (shows up as warnings in the UI)
      for (const w of todoWarnings) {
        // eslint-disable-next-line no-console
        console.error(
          `::warning file=${w.filePath}::Documentation contains ${w.count} TODO placeholder(s).`,
        );
      }
      // eslint-disable-next-line no-console
      console.error(
        `\nWarning: Found TODO placeholders in documentation files.\nFill/remove them to avoid stale/empty docs.\n`,
      );
    }

    const problems = [];
    if (missingDocs.length) {
      problems.push(
        `Missing doc stubs:\n${missingDocs.map((p) => `- ${p}`).join('\n')}`,
      );
    }
    if (changedReadmes.length) {
      problems.push(
        `Outdated module indexes:\n${changedReadmes.map((p) => `- ${p}`).join('\n')}`,
      );
    }
    if (pluginIndex.changed) {
      problems.push(`Outdated plugin index:\n- docs/plugins/PLUGIN-INDEX.md`);
    }
    if (adminPluginReadmes.changed) {
      problems.push(`Outdated admin plugin readmes:\n- ${ADMIN_PLUGIN_READMES_PATH}`);
    }

    if (problems.length) {
      // eslint-disable-next-line no-console
      console.error(
        `Docs index is out of date.\n\nRun: npm run docs:generate\n\n${problems.join(
          '\n\n',
        )}\n`,
      );
      process.exitCode = 1;
    }

    return;
  }

  // eslint-disable-next-line no-console
  console.log('Docs index generated.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
