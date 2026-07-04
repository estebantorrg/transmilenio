/** Tiny DOM helpers — no framework, just ergonomic vanilla. */

export { escapeHTML } from '@shared/utils/html';

type Attrs = Record<string, string | number | boolean | undefined | null> & {
  class?: string;
  html?: string;
  text?: string;
  dataset?: Record<string, string | number | undefined>;
};

/** Create an element with attributes/children in one call. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'html') el.innerHTML = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value as Record<string, string>)) {
        if (dv != null) el.dataset[dk] = String(dv);
      }
    } else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function qs<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(sel);
}

export function on<T extends HTMLElement>(
  el: T,
  event: string,
  handler: (e: Event) => void,
  opts?: AddEventListenerOptions
): T {
  el.addEventListener(event, handler, opts);
  return el;
}

/** Haptic tap when running inside the native shell (no-op on web). */
export function haptic(style: 'light' | 'medium' | 'heavy' = 'light'): void {
  const cap = (window as any).Capacitor;
  const hap = cap?.Plugins?.Haptics;
  try {
    if (hap?.impact) hap.impact({ style: style.charAt(0).toUpperCase() + style.slice(1) });
    else if (navigator.vibrate) navigator.vibrate(style === 'heavy' ? 18 : style === 'medium' ? 10 : 6);
  } catch {
    /* haptics are best-effort */
  }
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'info' | 'ok' | 'warn' = 'info'): void {
  const host = document.getElementById('toast-host');
  if (!host) return;
  host.innerHTML = '';
  const el = h('div', { class: `toast toast-${kind}`, text: message });
  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.remove('show');
    window.setTimeout(() => el.remove(), 240);
  }, 2600);
}
