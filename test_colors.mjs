import { C } from './src/colors.js';

console.log('Current color values:');
console.log('fg (normal text):', JSON.stringify(C.fg));
console.log('teal (bold):', JSON.stringify(C.teal));
console.log('white:', JSON.stringify(C.white));
console.log('');

// Test rendering
const test = '000 ** 123 ** 456';
const parts = test.split('**');

let output = '';
for (let i = 0; i < parts.length; i++) {
  if (i % 2 === 0) {
    // Normal text - should be white
    output += C.white + parts[i] + C.reset;
  } else {
    // Bold text - should be teal
    output += C.teal + C.bold + parts[i] + C.reset;
  }
}

console.log('Test output:');
console.log(output);
