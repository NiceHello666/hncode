const s = 'line 1\nline 2\n';
console.log('"line 1\\nline 2\\n".split("\\n").length =', s.split('\n').length, '-> trailing empty element becomes a line');
console.log('=> a 2500-line file written with a trailing newline reads back as 2501.');
