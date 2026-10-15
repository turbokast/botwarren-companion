/**
 * The terminal view: how long agent text is shown on the phone (design: the "Companion Terminal View" board, T1 and T2, in the Botwarren Claude Design project).
 * Plain text only (textContent, never markup), monospace on a dark terminal surface, whitespace and line breaks kept, colour codes removed, its own scroll
 * area with a maximum height so the page's buttons stay in reach, and four controls of at least 44 px: wrap, copy, expand. What the computer cut is said.
 * Expansion, wrapping and scroll position are kept across the page's redraws (a new state arrives while you read).
 */
import { cleanText } from '../../src/textclean.ts';
import { h } from './ui.ts';

interface Mem { open: boolean; wrap: boolean; top: number; left: number }
const memory = new Map<string, Mem>();
const mem = (key: string): Mem => { let m = memory.get(key); if (!m) { if (memory.size > 200) memory.delete(memory.keys().next().value as string); m = { open: false, wrap: true, top: 0, left: 0 }; memory.set(key, m); } return m; };

export interface TermOptions {
  /** identifies this box across redraws (e.g. the session and the message) */
  key: string;
  title: string;
  text: string;
  /** characters the computer cut from the end */
  cut?: number | undefined;
  /** the request the person is being asked to answer */
  ask?: boolean;
  testid?: string;
}

const kb = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

export function termBox(o: TermOptions): HTMLElement {
  const text = cleanText(o.text);
  const m = mem(o.key);
  const lines = text === '' ? 0 : text.split('\n').length;
  const size = new TextEncoder().encode(text).length;
  const body = h('div', { class: 'tv-body', tabindex: 0, role: 'region', 'aria-label': `${o.title}, scrollable`, 'data-testid': o.testid }, text);
  const fade = h('span', { class: 'tv-fade', 'aria-hidden': 'true' });
  const wrapBtn = h('button', { class: 'ghost tvb', 'data-testid': 'tv-wrap', 'aria-pressed': String(!m.wrap) });
  const copyBtn = h('button', { class: 'ghost tvb', 'data-testid': 'tv-copy' }, 'Copy');
  const openBtn = h('button', { class: 'ghost tvb', 'data-testid': 'tv-expand', 'aria-expanded': String(m.open) });
  const apply = (): void => {
    body.classList.toggle('open', m.open);
    body.classList.toggle('nowrap', !m.wrap);
    wrapBtn.textContent = m.wrap ? 'No wrap' : 'Wrap';
    wrapBtn.setAttribute('aria-pressed', String(!m.wrap));
    openBtn.textContent = m.open ? 'Collapse' : 'Expand';
    openBtn.setAttribute('aria-expanded', String(m.open));
    const overflowing = body.scrollHeight > body.clientHeight + 2;
    openBtn.style.display = m.open || overflowing ? '' : 'none';
    fade.style.display = !m.open && body.scrollHeight > body.clientHeight + 2 && body.scrollTop + body.clientHeight < body.scrollHeight - 2 ? '' : 'none';
  };
  wrapBtn.addEventListener('click', () => { m.wrap = !m.wrap; apply(); });
  openBtn.addEventListener('click', () => { m.open = !m.open; apply(); });
  copyBtn.addEventListener('click', () => {
    const done = (t: string): void => { copyBtn.textContent = t; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); };
    try { void navigator.clipboard.writeText(text).then(() => done('Copied'), () => done('Not copied')); } catch { done('Not copied'); }
  });
  body.addEventListener('scroll', () => { m.top = body.scrollTop; m.left = body.scrollLeft; apply(); }, { passive: true });
  // restore after the box is in the page (heights are known only then)
  requestAnimationFrame(() => { body.scrollTop = m.top; body.scrollLeft = m.left; apply(); });
  apply();
  const foot: HTMLElement[] = [];
  if (o.cut) foot.push(h('div', { class: 'tv-foot cut', 'data-testid': 'tv-cut' }, `Your computer cut ${o.cut.toLocaleString('en')} characters from the end of this. Read the rest at the terminal.`));
  return h('div', { class: `tv${o.ask ? ' ask' : ''}`, ...(o.testid ? { 'data-testid': `${o.testid}-box` } : {}) },
    h('div', { class: 'tv-head' }, h('span', { class: 'tvt' }, `${o.title} · ${lines} line${lines === 1 ? '' : 's'} · ${kb(size)}`), wrapBtn, copyBtn, openBtn),
    h('div', { class: 'tv-wrapper' }, body, fade), ...foot);
}
