// Install winpty or use native approach
const { execSync } = require('child_process');
const fs = require('fs');

try {
  console.log('Attempting to install winpty...');
  execSync('npm install winpty --save', { stdio: 'inherit' });
  console.log('✅ winpty installed successfully');
} catch (e) {
  console.log('❌ winpty installation failed, trying alternative...');
  
  // Alternative: Use node-windows-console or pure ANSI
  try {
    execSync('npm install node-windows-console --save', { stdio: 'inherit' });
    console.log('✅ node-windows-console installed');
  } catch (e2) {
    console.log('❌ All installations failed. Falling back to pure ANSI.');
    console.log('You can manually edit src/tui.js to use cursor positioning.');
  }
}
