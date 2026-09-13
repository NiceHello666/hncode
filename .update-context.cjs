// Update context windows for popular models based on official docs
const fs = require('fs');
const path = require('path');

const home = process.env.USERPROFILE || process.env.HOME;
const configFile = path.join(home, '.hncode', 'config.toml');

let config = fs.readFileSync(configFile, 'utf8');

// Official context windows (from model provider docs):
// - DeepSeek V4 Pro: 256K (official)
// - DeepSeek Flash: 256K (official)  
// - GLM-5 32B: 256K (official)
// - GLM-5 Flash: 1M (official)
// - Kimi k3: 256K (official)
// - Qwen3.8 Max: 256K (official)
// - Doubao Seed Pro: 256K (official)

const updates = [
  // DeepSeek models
  ['provider = "deepseek"\nmodel = "deepseek-flash"', 'provider = "deepseek"\nmodel = "deepseek-flash"\ncontext_length = 262144'],
  ['provider = "deepseek"\nmodel = "deepseek-v4-pro"', 'provider = "deepseek"\nmodel = "deepseek-v4-pro"\ncontext_length = 262144'],
  
  // Web-DeepSeek models (same as official)
  ['provider = "Web-DeepSeek"\nmodel = "deepseek-v4-flash"', 'provider = "Web-DeepSeek"\nmodel = "deepseek-v4-flash"\ncontext_length = 262144'],
  ['provider = "Web-DeepSeek"\nmodel = "deepseek-v4-pro"', 'provider = "Web-DeepSeek"\nmodel = "deepseek-v4-pro"\ncontext_length = 262144'],
  
  // GLM-5 models
  ['provider = "traebuddy"\nmodel = "glm-5.3-flash"', 'provider = "traebuddy"\nmodel = "glm-5.3-flash"\ncontext_length = 1048576'],
  ['provider = "workbuddy"\nmodel = "glm-5.3"', 'provider = "workbuddy"\nmodel = "glm-5.3"\ncontext_length = 262144'],
  ['provider = "workbuddy"\nmodel = "glm-5.3-flash"', 'provider = "workbuddy"\nmodel = "glm-5.3-flash"\ncontext_length = 1048576'],
  ['provider = "workbuddy"\nmodel = "glm-5.2"', 'provider = "workbuddy"\nmodel = "glm-5.2"\ncontext_length = 262144'],
  
  // Kimi models
  ['provider = "traebuddy"\nmodel = "kimi-k3"', 'provider = "traebuddy"\nmodel = "kimi-k3"\ncontext_length = 262144'],
  ['provider = "workbuddy"\nmodel = "kimi-k3-1"', 'provider = "workbuddy"\nmodel = "kimi-k3-1"\ncontext_length = 262144'],
  ['provider = "workbuddy"\nmodel = "kimi-k2.8-preview"', 'provider = "workbuddy"\nmodel = "kimi-k2.8-preview"\ncontext_length = 262144'],
  ['provider = "workbuddy"\nmodel = "kimi-k2.7"', 'provider = "workbuddy"\nmodel = "kimi-k2.7"\ncontext_length = 262144'],
  
  // Qwen models
  ['provider = "traebuddy"\nmodel = "qwen3.8-max"', 'provider = "traebuddy"\nmodel = "qwen3.8-max"\ncontext_length = 262144'],
  ['provider = "workbuddy"\nmodel = "qwen3.8-max"', 'provider = "workbuddy"\nmodel = "qwen3.8-max"\ncontext_length = 262144'],
  
  // Doubao models
  ['provider = "traebuddy"\nmodel = "Doubao-Seed-Evolving"', 'provider = "traebuddy"\nmodel = "Doubao-Seed-Evolving"\ncontext_length = 262144'],
  ['provider = "traebuddy"\nmodel = "Doubao-Seed-2.1-Pro"', 'provider = "traebuddy"\nmodel = "Doubao-Seed-2.1-Pro"\ncontext_length = 262144'],
];

let changed = false;
for (const [oldStr, newStr] of updates) {
  if (config.includes(oldStr)) {
    config = config.replace(oldStr, newStr);
    const modelName = oldStr.match(/model = "([^"]+)"/)?.[1] || 'unknown';
    console.log('✓ Updated context for:', modelName);
    changed = true;
  }
}

if (!changed) {
  console.log('No updates needed or patterns not found');
} else {
  fs.writeFileSync(configFile, config, 'utf8');
  console.log('Config updated successfully to:', configFile);
}
