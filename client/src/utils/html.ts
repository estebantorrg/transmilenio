export function escapeHTML(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeColor(value: string | null | undefined, fallback = '#64748B'): string {
  const color = value?.trim() ?? '';
  return /^#[0-9A-F]{6}$/i.test(color) ? color : fallback;
}
