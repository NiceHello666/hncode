// Single source of truth for the displayed version. The alternative was a
// hard-coded literal in index.js and tui.js that drifted apart from
// package.json (index said 0.1.0 while package.json was 0.3.0). Read the
// version from this package's own package.json instead, like update.js does.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function localVersion() {
  try {
    const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(here, 'utf8'));
    return pkg.version || '';
  } catch {
    return '0.0.0';
  }
}

export default localVersion();