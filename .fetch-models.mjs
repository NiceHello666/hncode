// Direct API calls to fetch model context lengths
import fs from 'node:fs';

const providers = [
  { name: 'traebuddy', baseUrl: 'http://127.0.0.1:7863/v1', apiKey: 'sk-114514' },
  { name: 'poolside', baseUrl: 'https://inference.poolside.ai/v1', apiKey: 'sky_gaW2giIW.nhfAHuGRT7uxhPuTLfapPupxHQzQWkKc' },
  { name: 'Web-DeepSeek', baseUrl: 'http://127.0.0.1:5001/v1', apiKey: 'sk-114514' },
  { name: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-89152b3fc63d475e8a846b3e3f36be92' }
];

async function fetchModels(provider) {
  try {
    const url = `${provider.baseUrl}/v1/models`;
    const headers = { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`
    };
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    console.log(`\n📡 Fetching from ${provider.name}...`);
    const response = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeout);
    
    if (!response.ok) {
      console.log(`   ❌ HTTP ${response.status}: ${response.statusText}`);
      return [];
    }
    
    const data = await response.json();
    const models = data.data || [];
    
    if (models.length === 0) {
      console.log(`   ℹ No models returned`);
      return [];
    }
    
    console.log(`   ✓ Found ${models.length} models:`);
    for (const model of models) {
      const id = model.id || model.name || '';
      const ctx = model.context_length || model.contextLength || model.max_context_size || 0;
      const maxTokens = model.max_tokens || model.maxOutputTokens || 0;
      
      if (ctx > 0) {
        console.log(`     • ${id.padEnd(40)} → ${ctx.toLocaleString().padStart(10)} tokens${maxTokens ? ` (max: ${maxTokens})` : ''}`);
      } else {
        console.log(`     • ${id.padEnd(40)} → NO CONTEXT LENGTH`);
      }
    }
    
    return models.map(m => ({
      id: m.id || m.name || '',
      contextLength: m.context_length || m.contextLength || m.max_context_size || 0,
      maxTokens: m.max_tokens || m.maxOutputTokens || 0
    }));
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
    return [];
  }
}

console.log('='.repeat(80));
console.log('Fetching model context lengths from all providers');
console.log('='.repeat(80));

for (const provider of providers) {
  await fetchModels(provider);
}

console.log('\n' + '='.repeat(80));
console.log('Done! Check the output above for context length information.');
console.log('='.repeat(80));
