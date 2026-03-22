import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const LIB_DIR = path.join(ROOT, 'lib');

const LIMITS = {
  js: 512 * 1024,
  css: 64 * 1024,
  json: 64 * 1024,
};

const normalizeRelPath = (filePath) =>
  path.relative(ROOT, filePath).split(path.sep).join('/');

const isAdminUiDistAsset = (relPath) =>
  relPath.includes('/admin-ui/dist/') &&
  (relPath.endsWith('.js') || relPath.endsWith('.css'));

const isAdminUiI18nJson = (relPath) =>
  relPath.includes('/admin-ui/i18n/') && relPath.endsWith('.json');

const formatKb = (bytes) => (bytes / 1024).toFixed(1);
const args = new Set(process.argv.slice(2));
const shouldList = args.has('--list') || args.has('--verbose');
const shouldHelp = args.has('--help') || args.has('-h');

const walk = async (dir, files) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
};

const main = async () => {
  if (shouldHelp) {
    console.log('admin-ui bundle check');
    console.log('Usage: node admin-ui-bundle-check.mjs [--list|--verbose]');
    console.log('Limits: JS 512 KB, CSS 64 KB, i18n JSON 64 KB');
    return;
  }

  try {
    await fs.access(LIB_DIR);
  } catch {
    console.log('admin-ui bundle check: lib/ not found, skipping.');
    return;
  }

  const files = [];
  await walk(LIB_DIR, files);

  const violations = [];
  const matched = [];

  for (const file of files) {
    const relPath = normalizeRelPath(file);

    let limit = null;
    if (isAdminUiDistAsset(relPath)) {
      limit = relPath.endsWith('.js') ? LIMITS.js : LIMITS.css;
    } else if (isAdminUiI18nJson(relPath)) {
      limit = LIMITS.json;
    } else {
      continue;
    }

    matched.push(relPath);
    const { size } = await fs.stat(file);
    if (size > limit) {
      violations.push({
        relPath,
        size,
        limit,
      });
    }
  }

  if (matched.length === 0) {
    console.log('admin-ui bundle check: no matching bundle files found.');
    return;
  }

  if (shouldList) {
    console.log('admin-ui bundle files:');
    for (const relPath of matched) {
      const { size } = await fs.stat(path.join(ROOT, relPath));
      console.log(
        `- ${relPath}: ${size} bytes (${formatKb(size)} KB)`
      );
    }
  }

  if (violations.length > 0) {
    console.error('admin-ui bundle size violations:');
    for (const v of violations) {
      console.error(
        `- ${v.relPath}: ${v.size} bytes (${formatKb(v.size)} KB) > ${v.limit} bytes (${formatKb(v.limit)} KB)`
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(`admin-ui bundle check: OK (${matched.length} files checked).`);
};

main().catch((err) => {
  console.error('admin-ui bundle check failed:', err);
  process.exitCode = 1;
});
