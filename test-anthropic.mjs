// Quick test to verify Anthropic protocol implementation
import { toAnthropic } from './src/llm.js';

const testMessages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello, how are you?' },
  { role: 'assistant', content: 'I am doing well, thank you!', toolCalls: [] },
];

try {
  const result = toAnthropic(testMessages);
  console.log('✅ Anthropic protocol conversion successful!');
  console.log('\nConverted request:');
  console.log(JSON.stringify(result, null, 2));
  
  // Verify structure
  if (result.system && Array.isArray(result.messages)) {
    console.log('\n✅ Structure is correct:');
    console.log(`   - System messages: ${result.system.length}`);
    console.log(`   - Message blocks: ${result.messages.length}`);
    
    // Check user message format
    const userMsg = result.messages.find(m => m.role === 'user');
    if (userMsg && userMsg.content[0].type === 'text') {
      console.log('   ✅ User message format correct');
    }
    
    // Check assistant message format
    const assistantMsg = result.messages.find(m => m.role === 'assistant');
    if (assistantMsg && Array.isArray(assistantMsg.content)) {
      console.log('   ✅ Assistant message format correct');
    }
  }
} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}
