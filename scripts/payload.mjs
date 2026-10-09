export function payload(targetBytes, control) {
  const base = '/restaurant/downtown/menu?meal=';
  const value = control ? '@meal' : ':meal';
  const parts = [];
  let path = '';
  for (let i = 0; i < 2000; i++) {
    const next = base + encodeURIComponent('lunch?' + [...parts, `q${i}=${value}`].join('&'));
    if (next.length > targetBytes && parts.length) break;
    parts.push(`q${i}=${value}`);
    path = next;
  }
  return { path, markers: parts.length };
}
