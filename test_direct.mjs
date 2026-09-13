import { C } from './src/colors.js';

console.log('Testing direct color output:');
console.log('============================');
console.log('');

// Test 1: Plain text with white
console.log('Test 1 - Plain white text:');
console.log(C.white + 'This should be WHITE' + C.reset);
console.log('');

// Test 2: Bold teal text
console.log('Test 2 - Bold TEAL text:');
console.log(C.teal + C.bold + '**This should be BOLD TEAL**' + C.reset);
console.log('');

// Test 3: Mixed
console.log('Test 3 - Mixed (000 is white, 123 is bold teal):');
const test = '000 ** 123 ** 456';
const parts = test.split('**');
let output = '';
for (let i = 0; i < parts.length; i++) {
  if (i % 2 === 0) {
    output += C.white + parts[i] + C.reset;
  } else {
    output += C.teal + C.bold + parts[i] + C.reset;
  }
}
console.log(output);
console.log('');

// Show actual color codes being used
console.log('Color codes being used:');
console.log('C.white:', JSON.stringify(C.white));
console.log('C.teal:', JSON.stringify(C.teal));
console.log('C.fg:', JSON.stringify(C.fg));
