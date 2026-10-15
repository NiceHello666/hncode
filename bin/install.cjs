#!/usr/bin/env node
/**
 * hncode auto-install script
 * Creates default configuration and sets up the environment
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Get user home directory (cross-platform)
const homeDir = os.homedir();
const configDir = path.join(homeDir, '.hncode');
const configFile = path.join(configDir, 'config.toml');
const sessionsDir = path.join(configDir, 'sessions');
const pluginsDir = path.join(configDir, 'plugins');

console.log('🚀 Setting up hncode...\n');

// Create directories if they don't exist
const dirs = [configDir, sessionsDir, pluginsDir];
for (const dir of dirs) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✓ Created directory: ${dir}`);
  } else {
    console.log(`✓ Directory exists: ${dir}`);
  }
}

// Check if config file exists
if (!fs.existsSync(configFile)) {
  const defaultConfig = `# hncode configuration
#
# Nothing here is required: every value has a default, and the same keys can be set with
# HNCODE_* environment variables or from /settings once hncode is running.
#
# Model and provider are deliberately left out. Naming one here starts hncode on a model
# you may have no key for, and the first turn fails against that provider instead of
# asking you to choose. Set up a provider with /provider, then pick a model with /model.

# [providers.openai]
# base_url = "https://api.openai.com/v1"
# api_key  = "sk-..."       # or set HNCODE_API_KEY
# protocol = "openai"
`;

  fs.writeFileSync(configFile, defaultConfig);
  console.log(`\n✅ Created default configuration at: ${configFile}`);
  console.log('\n💡 Next steps:');
  console.log('   1. Start hncode and run /provider to add an API key');
  console.log('   2. Then /model to pick one');
  console.log('   Both write to the config above, so there is nothing to edit by hand.');
} else {
  console.log(`\nℹ️  Configuration already exists at: ${configFile}`);
  console.log('   Run "hncode init" to regenerate or edit manually.');
}

console.log('\n✨ hncode is ready to use!');

// Tell the user how to pick up the new command.
//
// This used to run PowerShell to prepend the npm global path, and print "Environment
// refreshed automatically". That cannot work: `execSync` starts a CHILD shell, so the
// `$env:Path` it sets dies with that process. The claim is gone; the note below is true.
if (os.platform() === 'win32') {
  console.log('ℹ️  If "hncode" is not found, open a new terminal (the PATH is updated at');
  console.log('   login), or run this in the current one:');
  console.log('     $env:Path = [System.Environment]::GetEnvironmentVariable("Path","User") + ";" + $env:Path');
} else {
  console.log('ℹ️  If "hncode" is not found, open a new terminal, or re-read your shell');
  console.log('   configuration:  source ~/.zshrc   (or ~/.bashrc)');
}

console.log('');
console.log('   Type "hncode --help" for available commands.\n');