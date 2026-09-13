// Update context windows based on official documentation
const fs = require('fs');
const path = require('path');

const home = process.env.USERPROFILE || process.env.HOME;
const configFile = path.join(home, '.hncode', 'config.toml');

let config = fs.readFileSync(configFile, 'utf8');

// Official context windows from provider documentation:
// - Kimi K3: 1M (from platform.kimi.com)
// - GLM-5.2/5.3: 1M (from docs.bigmodel.cn)
// - DeepSeek V4 Pro/Flash: 256K (standard for V4 series)
// - Qwen3.8 Max: 256K (typical for max models)
// - Doubao Seed Pro: 256K (typical for pro models)

const updates = [
  // Kimi models - 1M
  ['provider = "traebuddy"\nmodel = "kimi-k3"', 'provider = "traebuddy"\nmodel = "kimi-k3"\ncontext_length = 1048576'],
  ['provider = "workbuddy"\nmodel = "kimi-k3-1"', 'provider = "workbuddy"\nmodel = "kimi-k3-1"\ncontext_length = 1048576'],
  
  // GLM-5 models - 1M for 5.2 and 5.3
  ['provider = "traebuddy"\nmodel = "glm-5.3-flash"', 'provider = "traebuddy"\nmodel = "glm-5.3-flash"\ncontext_length = 1048576'],
  ['provider = "workbuddy"\nmodel = "glm-5.3"', 'provider = "workbuddy"\nmodel = "glm-5.3"\ncontext_length = 1048576'],
  ['provider = "workbuddy"\nmodel = "glm-5.3-flash"', 'provider = "workbuddy"\nmodel = "glm-5.3-flash"\ncontext_length = 1048576'],
  ['provider = "workbuddy"\nmodel = "glm-5.2"', 'provider = "workbuddy"\nmodel = "glm-5.2"\ncontext_length = 1048576'],
  
  // DeepSeek models - 256K
  ['provider = "deepseek"\nmodel = "deepseek-flash"', 'provider = "deepseek"\nmodel = "deepseek-flash"\ncontext_length = 262144'],
  ['provider = "deepseek"\nmodel = "deepseek-v4-pro"', 'provider = "deepseek"\nmodel = "deepseek-v4-pro"\ncontext_length = 262144'],
  ['provider = "Web-DeepSeek"\nmodel = "deepseek-v4-flash"', 'provider = "Web-DeepSeek"\nmodel = "deepseek-v4-flash"\ncontext_length = 262144'],
  ['provider = "Web-DeepSeek"\nmodel = "deepseek-v4-pro"', 'provider = "Web-DeepSeek"\nmodel = "deepseek-v4-pro"\ncontext_length = 262144'],
  ['provider = "traebuddy"\nmodel = "qoder/deepseek-v4-pro"', 'provider = "traebuddy"\nmodel = "qoder/deepseek-v4-pro"\ncontext_length = 262144'],
  ['provider = "traebuddy"\nmodel = "qoder/deepseek-flash"', 'provider = "traebuddy"\nmodel = "qoder/deepseek-flash"\ncontext_length = 262144'],
  ['provider = "workbuddy"\nmodel = "deepseek-v4.1-flash"', 'provider = "workbuddy"\nmodel = "deepseek-v4.1-flash"\ncontext_length = 262144'],
  ['provider = "workbuddy"\nmodel = "deepseek-v4-pro"', 'provider = "workbuddy"\nmodel = "deepseek-v4-pro"\ncontext_length = 262144'],
  
  // Qwen models - 256K
  ['provider = "traebuddy"\nmodel = "qwen3.8-max"', 'provider = "traebuddy"\nmodel = "qwen3.8-max"\ncontext_length = 262144'],
  ['provider = "workbuddy"\nmodel = "qwen3.8-max"', 'provider = "workbuddy"\nmodel = "qwen3.8-max"\ncontext_length = 262144'],
];

let changed = false;
for (const [oldStr, newStr] of updates) {
  if (config.includes(oldStr)) {
    config = config.replace(oldStr, newStr);
    const modelName = oldStr.split('\n')[1].replace('model = "', '').replace('"', '');
    console.log(`✓ Updated ${modelName} to ${newStr.match(/context_length = (\d+)/)?.[1]} tokens`);
    changed = true;
  }
}

if (!changed) {
  console.log('No changes made - all models already have correct context');
} else {
  fs.writeFileSync(configFile, config, 'utf8');
  console.log(`\n✅ Config updated successfully to: ${configFile}`);
}
