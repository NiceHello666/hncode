#!/usr/bin/env node
/**
 * hncode pre-install script
 * Checks environment requirements before installation
 */

const os = require('os');
const path = require('path');

console.log('🔍 Checking environment...\n');

// Check Node.js version
const nodeVersion = process.version.replace('v', '');
const [major] = nodeVersion.split('.').map(Number);

if (major < 20) {
  console.warn(`⚠️  Warning: Node.js v${nodeVersion} detected.`);
  console.warn('   hncode requires Node.js >= 20. Please upgrade.');
  process.exit(1);
} else {
  console.log(`✓ Node.js v${nodeVersion} ✓`);
}

// Check platform
const platform = os.platform();
console.log(`✓ Platform: ${platform}`);

console.log('✅ Environment check passed!\n');