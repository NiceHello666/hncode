// Fetch /v1/models from all providers and update context lengths automatically
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.USERPROFILE || process.env.HOME;
const configFile = path.join(home, '.hncode', 'config.toml');

let configText = fs.readFileSync(configFile, 'utf8');

// Parse existing models from config
const modelMatches = configText.match(/\[models\."([^"]+)"\][\s\S]*?provider = "([^"]+)"/g);
if (!modelMatches) {
  console.log('No models found in config');
  process.exit(0);
}

console.log(`Found ${modelMatches.length} model entries to check...`);

// Extract unique providers
const providerSet = new Set();
for (const match of modelMatches) {
  const provMatch = match.match(/provider = "([^"]+)"/);
  if (provMatch) providerSet.add(provMatch[1]);
}

console.log(`Checking ${providerSet.size} unique providers...\n`);

// Fetch models from each provider
async function fetchProviderModels(providerName, baseUrl, apiKey, protocol) {
  try {
    const url = `${baseUrl}/v1/models`;
    const headers = { 'Content-Type': 'application/json' };
    
    if (protocol === 'anthropic') {
      if (apiKey) headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeout);
    
    if (!response.ok) {
      console.log(`⚠ ${providerName}: HTTP ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.log(`✗ ${providerName}: ${error.message}`);
    return null;
  }
}

// Get provider configs from file
const providerConfigs = {};
const providerMatches = configText.match(/\[providers\.([^\]]+)\][\s\S]*?base_url = "([^"]+)".*?api_key = "([^"]+)".*?protocol = "([^"]+)"/g);
if (providerMatches) {
  for (const match of providerMatches) {
    const nameMatch = match.match(/\[providers\.([^\]]+)\]/);
    const urlMatch = match.match(/base_url = "([^"]+)"/);
    const keyMatch = match.match(/api_key = "([^"]+)"/);
    const protoMatch = match.match(/protocol = "([^"]+)"/);
    
    if (nameMatch && urlMatch && keyMatch && protoMatch) {
      providerConfigs[nameMatch[1]] = {
        baseUrl: urlMatch[1],
        apiKey: keyMatch[1],
        protocol: protoMatch[1]
      };
    }
  }
}

// Process each provider
const results = [];
for (const [providerName, config] of Object.entries(providerConfigs)) {
  console.log(`📡 Fetching models from ${providerName}...`);
  const models = await fetchProviderModels(providerName, config.baseUrl, config.apiKey, config.protocol);
  
  if (!models || models.length === 0) {
    console.log(`   No models returned\n`);
    continue;
  }
  
  console.log(`   Found ${models.length} models:\n`);
  for (const model of models) {
    const modelId = model.id || model.name || '';
    const contextLength = model.context_length || model.contextLength || model.max_context_size || 0;
    const maxTokens = model.max_tokens || model.maxOutputTokens || 0;
    
    if (contextLength > 0) {
      console.log(`   ✓ ${modelId}: ${contextLength.toLocaleString()} tokens${maxTokens ? ` (max_output: ${maxTokens})` : ''}`);
      results.push({ provider: providerName, modelId, contextLength });
    } else {
      console.log(`   ⚠ ${modelId}: no context_length field`);
    }
  }
  console.log('');
}

// Now update config.toml with fetched values
console.log('🔄 Updating config.toml with fetched context lengths...');

let updatedConfig = configText;
let changesMade = false;

for (const result of results) {
  // Find the model entry in config
  const fullPattern = new RegExp(`\\[models\\."(${result.provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^"]+)"\\][\\s\\S]{0,200}provider = "${result.provider}"[\\s\\S]{0,200}model = "[^"]+"\n(?:\\s+context_length = \\d+\n)?`, 'm');
  
  const matches = configText.match(fullPattern);
  if (matches) {
    const oldEntry = matches[0];
    const lines = oldEntry.split('\n');
    const modelLineIndex = lines.findIndex(l => l.includes('model = "'));
    
    if (modelLineIndex >= 0) {
      // Remove existing context_length line if present
      let cleanLines = lines.filter((l, i) => i !== modelLineIndex + 1 || !l.trim().startsWith('context_length'));
      
      // Add new context_length after model line
      const modelLine = cleanLines[modelLineIndex];
      cleanLines.splice(modelLineIndex + 1, 0, `  context_length = ${result.contextLength}`);
      
      const newEntry = cleanLines.join('\n');
      updatedConfig = updatedConfig.replace(oldEntry, newEntry);
      changesMade = true;
      
      const modelName = modelLine.match(/model = "([^"]+)"/)?.[1];
      console.log(`✓ Updated ${result.provider}/${modelName}: ${result.contextLength.toLocaleString()} tokens`);
    }
  }
}

if (changesMade) {
  fs.writeFileSync(configFile, updatedConfig, 'utf8');
  console.log(`\n✅ Successfully updated ${configFile}`);
} else {
  console.log('\nℹ No updates needed or patterns not found');
}
