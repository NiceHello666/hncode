// Update DeepSeek models to 1M context as requested
const fs = require('fs');
const path = require('path');

const home = process.env.USERPROFILE || process.env.HOME;
const configFile = path.join(home, '.hncode', 'config.toml');

let config = fs.readFileSync(configFile, 'utf8');

// DeepSeek V4 series: 1M tokens (as per your confirmation)
const updates = [
  ['provider = "deepseek"\nmodel = "deepseek-flash"', 'provider = "deepseek"\nmodel = "deepseek-flash"\ncontext_length = 1048576'],
  ['provider = "deepseek"\nmodel = "deepseek-v4-pro"', 'provider = "deepseek"\nmodel = "deepseek-v4-pro"\ncontext_length = 1048576'],
  ['provider = "Web-DeepSeek"\nmodel = "deepseek-v4-flash"', 'provider = "Web-DeepSeek"\nmodel = "deepseek-v4-flash"\ncontext_length = 1048576'],
  ['provider = "Web-DeepSeek"\nmodel = "deepseek-v4-pro"', 'provider = "Web-DeepSeek"\nmodel = "deepseek-v4-pro"\ncontext_length = 1048576'],
  ['provider = "traebuddy"\nmodel = "qoder/deepseek-v4-pro"', 'provider = "traebuddy"\nmodel = "qoder/deepseek-v4-pro"\ncontext_length = 1048576'],
  ['provider = "traebuddy"\nmodel = "qoder/deepseek-flash"', 'provider = "traebuddy"\nmodel = "qoder/deepseek-flash"\ncontext_length = 1048576'],
  ['provider = "workbuddy"\nmodel = "deepseek-v4.1-flash"', 'provider = "workbuddy"\nmodel = "deepseek-v4.1-flash"\ncontext_length = 1048576'],
  ['provider = "workbuddy"\nmodel = "deepseek-v4-pro"', 'provider = "workbuddy"\nmodel = "deepseek-v4-pro"\ncontext_length = 1048576'],
];

let changed = false;
for (const [oldStr, newStr] of updates) {
  if (config.includes(oldStr)) {
    config = config.replace(oldStr, newStr);
    const modelName = oldStr.split('\n')[1].replace('model = "', '').replace('"', '');
    console.log(`✓ Updated ${modelName} to 1M (1048576) tokens`);
    changed = true;
  }
}

if (!changed) {
  console.log('No changes made - all DeepSeek models already have 1M context');
} else {
  fs.writeFileSync(configFile, config, 'utf8');
  console.log(`\n✅ Config updated successfully! All DeepSeek models now have 1M context window.`);
}
