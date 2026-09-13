const p = '╭───────────────────────────────────────────────────────╮';
console.log('matches:', /^╭─+╮$/.test(p));
console.log('len:', p.length);
console.log('last char code:', p.charCodeAt(p.length-1));
