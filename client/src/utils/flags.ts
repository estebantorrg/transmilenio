/**
 * Features built but held back for a go/no-go (planA2 step 8). Off for every
 * visitor; on in one browser with `?flag=<name>`, which that browser remembers,
 * and off again with `?flag=-<name>`. The prerendered pages never show them.
 */
const KEY = 'mitrasto-flags';

export function flagOn(name: string): boolean {
  try {
    const on = new Set((localStorage.getItem(KEY) ?? '').split(',').filter(Boolean));
    for (const f of new URLSearchParams(location.search).getAll('flag')) {
      if (f.startsWith('-')) on.delete(f.slice(1));
      else on.add(f);
    }
    localStorage.setItem(KEY, [...on].join(','));
    return on.has(name);
  } catch {
    return false;
  }
}
