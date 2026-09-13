// Force reload colors module
import fs from 'fs';

// Clear require cache
delete require.cache[require.resolve('./src/colors.js')];

const { C, setTheme } = await import('./src/colors.js');

console.log('Before setTheme:');
console.log('fg:', JSON.stringify(C.fg));
console.log('teal:', JSON.stringify(C.teal));

// Force set theme to dark
setTheme('dark');

console.log('\nAfter setTheme("dark"):');
console.log('fg:', JSON.stringify(C.fg));
console.log('teal:', JSON.stringify(C.teal));
console.log('cyan:', JSON.stringify(C.cyan));

// Verify the values
const fgHex = C.fg.replace(/\x1b\[[0-9;]+m/g, '');
const tealHex = C.teal.replace(/\x1b\[[0-9;]+m/g, '');

console.log('\nActual RGB values (approximate):');
console.log('fg should be white [255,255,255]');
console.log('teal should be [0,200,230]');
