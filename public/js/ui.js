import { h, useEffect, useId, useRef, useState } from './preact.js';
import { Icon } from './icons.js';
import { initials, copyText } from './util.js';

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Buttons                                                                    */
/* -------------------------------------------------------------------------- */

export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  loading = false,
  icon = null,
  iconRight = null,
  type = 'button',
  class: className = '',
  children,
  ...rest
}) {
  const classes = cx(
    'btn',
    `btn-${variant}`,
    size === 'sm' && 'btn-sm',
    size === 'lg' && 'btn-lg',
    block && 'btn-block',
    className
  );
  return h(
    'button',
    { type, class: classes, 'aria-busy': loading || undefined, ...rest },
    loading ? h('span', { class: cx('spinner', variant === 'primary' && 'on-accent') }) : (icon ? h(Icon, { name: icon, size: 18 }) : null),
    children != null ? h('span', null, children) : null,
    iconRight ? h(Icon, { name: iconRight, size: 17 }) : null
  );
}

export function IconButton({
  name,
  label,
  size = 20,
  class: className = '',
  tone = '',
  type = 'button',
  badge = null,
  ...rest
}) {
  return h(
    'button',
    {
      type,
      class: cx('icon-btn', className, tone),
      'aria-label': label,
      title: rest.title || label,
      ...rest
    },
    h(Icon, { name, size }),
    badge != null ? h('span', { class: 'badge' }, badge) : null
  );
}

export function LinkButton({ class: className = '', children, ...rest }) {
  return h('button', { type: 'button', class: cx('link-btn', className), ...rest }, children);
}

/* -------------------------------------------------------------------------- */
/* Avatar                                                                     */
/* -------------------------------------------------------------------------- */

export function Avatar({ name, color = 0, size = 'md', online = false, class: className = '', raised = false }) {
  return h(
    'span',
    { class: cx('avatar-wrap', className) },
    h(
      'span',
      {
        class: cx('avatar', size),
        'data-color': String(Math.abs(Number(color) || 0) % 8),
        'aria-hidden': 'true'
      },
      initials(name)
    ),
    online ? h('span', { class: cx('online-dot', raised && 'raised', size === 'sm' && 'sm'), 'aria-label': 'Online' }) : null
  );
}

/* -------------------------------------------------------------------------- */
/* Form controls                                                              */
/* -------------------------------------------------------------------------- */

export function Field({ label, hint, error, htmlFor, children, class: className = '' }) {
  return h(
    'div',
    { class: cx('field', className) },
    label ? h('label', { class: 'label', for: htmlFor }, label) : null,
    children,
    error ? h('p', { class: 'error-text', role: 'alert' }, error) : (hint ? h('p', { class: 'hint' }, hint) : null)
  );
}

export function Switch({ checked, onChange, disabled = false, label, id }) {
  return h(
    'button',
    {
      type: 'button',
      id,
      class: 'switch',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      'aria-label': label,
      disabled,
      onClick: () => onChange?.(!checked)
    }
  );
}

export function Segmented({ value, options, onChange, label }) {
  return h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': label },
    options.map((option) => h(
      'button',
      {
        key: option.value,
        type: 'button',
        class: 'segment',
        'aria-pressed': value === option.value ? 'true' : 'false',
        onClick: () => onChange?.(option.value)
      },
      option.label
    ))
  );
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                   */
/* -------------------------------------------------------------------------- */

export function Spinner({ size = 'sm', label = 'Loading' }) {
  return h('span', { class: cx('spinner', size === 'lg' && 'lg'), role: 'status', 'aria-label': label });
}

export function Banner({ tone = 'info', icon = 'info', title, children, actions, class: className = '' }) {
  return h(
    'div',
    { class: cx('banner', tone, className), role: tone === 'danger' ? 'alert' : undefined },
    icon ? h(Icon, { name: icon, size: 17 }) : null,
    h(
      'div',
      { class: 'banner-body' },
      title ? h('p', { class: 'banner-title' }, title) : null,
      children,
      actions ? h('div', { class: 'banner-actions' }, actions) : null
    )
  );
}

export function EmptyState({ icon = 'message', title, children, action, art = true }) {
  return h(
    'div',
    { class: 'empty' },
    art ? h('div', { class: 'empty-art', 'aria-hidden': 'true' }, h(Icon, { name: icon, size: 30 })) : null,
    title ? h('p', { class: 'empty-title' }, title) : null,
    children ? h('p', { class: 'empty-sub' }, children) : null,
    action ? h('div', { class: 'mt-12' }, action) : null
  );
}

export function Skeleton({ width = '100%', height = 12, radius = 6, class: className = '' }) {
  return h('div', {
    class: cx('skeleton', className),
    style: { width, height: `${height}px`, borderRadius: `${radius}px` }
  });
}

/* -------------------------------------------------------------------------- */
/* Sheet                                                                      */
/* -------------------------------------------------------------------------- */

export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer = null,
  full = false,
  wide = false,
  flush = false,
  tight = false,
  grip = true,
  headExtra = null
}) {
  const titleId = useId();
  const panel = useRef(null);
  const restore = useRef(null);

  useEffect(() => {
    restore.current = document.activeElement;
    const node = panel.current;
    if (node) {
      const focusable = node.querySelector(
        'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])'
      );
      if (focusable) focusable.focus({ preventScroll: true });
      else node.focus({ preventScroll: true });
    }
    const onKey = (event) => {
      if (event.key !== 'Tab' || !node) return;
      const items = Array.from(node.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter((item) => item.offsetParent !== null || item === document.activeElement);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const target = restore.current;
      if (target && typeof target.focus === 'function' && document.contains(target)) {
        try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    };
  }, []);

  return h(
    'div',
    {
      class: 'sheet-backdrop',
      onPointerDown: (event) => {
        if (event.target === event.currentTarget) onClose?.();
      }
    },
    h(
      'div',
      {
        ref: panel,
        class: cx('sheet-panel', full && 'full', wide && 'wide'),
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': title ? titleId : undefined,
        tabindex: '-1'
      },
      grip && !full ? h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }) : null,
      title
        ? h(
            'div',
            { class: 'sheet-head' },
            h(
              'div',
              { class: 'grow' },
              h('h2', { class: 'sheet-title', id: titleId }, title),
              subtitle ? h('p', { class: 'sheet-sub' }, subtitle) : null
            ),
            headExtra,
            h(IconButton, { name: 'x', label: 'Close', onClick: onClose })
          )
        : null,
      h('div', { class: cx('sheet-body', flush && 'flush', tight && 'tight') }, children),
      footer ? h('div', { class: 'sheet-foot' }, footer) : null
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Toasts                                                                     */
/* -------------------------------------------------------------------------- */

const TOAST_ICONS = {
  ok: 'check',
  warn: 'alert',
  danger: 'alert',
  info: 'info',
  neutral: 'info'
};

export function ToastHost({ toasts, onDismiss }) {
  if (!toasts?.length) return null;
  return h(
    'div',
    { class: 'toast-host', role: 'region', 'aria-label': 'Notifications', 'aria-live': 'polite' },
    toasts.map((toast) => h(
      'div',
      { key: toast.id, class: cx('toast', toast.tone) },
      h(Icon, { name: TOAST_ICONS[toast.tone] || 'info', size: 18, class: 'toast-icon' }),
      h('span', { class: 'toast-text' }, toast.message),
      toast.action
        ? h('button', {
            type: 'button',
            class: 'toast-action',
            onClick: () => {
              onDismiss?.(toast.id);
              toast.action.run?.();
            }
          }, toast.action.label)
        : null,
      h('button', {
        type: 'button',
        class: 'icon-btn sm',
        'aria-label': 'Dismiss',
        onClick: () => onDismiss?.(toast.id)
      }, h(Icon, { name: 'x', size: 15 }))
    ))
  );
}

/* -------------------------------------------------------------------------- */
/* Hooks                                                                      */
/* -------------------------------------------------------------------------- */

export function useCopy(timeout = 1800) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (text) => {
    const ok = await copyText(text);
    if (!ok) return false;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), timeout);
    return true;
  };
  return [copied, copy];
}

export function useInterval(fn, delay) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!delay) return undefined;
    const id = setInterval(() => saved.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}
