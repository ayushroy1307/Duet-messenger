import { h, useEffect, useState } from './preact.js';
import {
  Avatar,
  Banner,
  Button,
  Field,
  Segmented,
  Sheet,
  Switch,
  useInterval
} from './ui.js';
import { Icon } from './icons.js';
import {
  backupNow,
  changePin,
  clearDecryptedCache,
  closeSheet,
  disableBiometricUnlock,
  enableBiometricUnlock,
  errorMessage,
  exportDiagnostics,
  loadSessions,
  lockVault,
  openSheet,
  pushStatus,
  refreshStorageEstimate,
  state,
  toast,
  toggleDiagnostics,
  togglePush,
  updateSettings,
  useApp
} from './store.js';
import { biometricAvailability } from './vault.js';
import { downloadText, formatRelative, humanSize, truncate } from './util.js';

/* -------------------------------------------------------------------------- */
/* Small building blocks                                                      */
/* -------------------------------------------------------------------------- */

function Row({ icon, title, sub, action, onClick, danger = false, children }) {
  const trailing = action || (onClick ? children : null);
  const content = [
    icon ? h('span', { class: 'set-icon' }, h(Icon, { name: icon, size: 17 })) : null,
    h(
      'div',
      { class: 'set-row-main' },
      h('p', { class: 'set-row-title' }, title),
      sub ? h('p', { class: 'set-row-sub' }, sub) : null,
      onClick ? null : children
    ),
    trailing ? h('span', { class: 'set-row-action' }, trailing) : null
  ];
  if (onClick) {
    return h(
      'button',
      { type: 'button', class: `set-row${danger ? ' danger' : ''}`, onClick },
      content
    );
  }
  return h('div', { class: `set-row${danger ? ' danger' : ''}` }, content);
}

function Group({ title, children }) {
  return h(
    'section',
    { class: 'set-group' },
    title ? h('h2', { class: 'set-group-title' }, title) : null,
    h('div', { class: 'set-card' }, children)
  );
}

const THEME_OPTIONS = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
];

const LOCK_OPTIONS = [
  { value: 0, label: 'Never' },
  { value: 1, label: 'After 1 minute' },
  { value: 5, label: 'After 5 minutes' },
  { value: 15, label: 'After 15 minutes' },
  { value: 30, label: 'After 30 minutes' },
  { value: 60, label: 'After 1 hour' }
];

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export function SettingsSheet() {
  const app = useApp();
  const [biometrics, setBiometrics] = useState({ available: false, reason: null, checked: false });
  const [pushBusy, setPushBusy] = useState(false);
  const [securityBusy, setSecurityBusy] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadSessions().catch(() => {});
    refreshStorageEstimate();
    biometricAvailability().then((result) => {
      if (!cancelled) setBiometrics({ ...result, checked: true });
    }).catch(() => {
      if (!cancelled) setBiometrics({ available: false, reason: 'Biometric unlock is unavailable here.', checked: true });
    });
    return () => { cancelled = true; };
  }, []);

  useInterval(() => setTick((value) => value + 1), 60_000);

  const push = pushStatus();
  const user = app.auth.user || {};
  const name = user.displayName || 'Your profile';
  const storage = app.storage || { usage: 0, quota: 0 };
  const percent = storage.quota ? Math.min(100, Math.round((storage.usage / storage.quota) * 100)) : 0;

  const onNotify = async (enabled) => {
    setPushBusy(true);
    try {
      await togglePush(enabled);
    } catch (error) {
      toastError(error);
    } finally {
      setPushBusy(false);
    }
  };

  const onBiometric = async (enabled) => {
    setSecurityBusy(true);
    try {
      if (enabled) await enableBiometricUnlock();
      else await disableBiometricUnlock();
    } catch (error) {
      toastError(error);
    } finally {
      setSecurityBusy(false);
    }
  };

  return h(
    Sheet,
    {
      title: 'Settings',
      subtitle: `${name} · ${user.username ? `@${user.username}` : 'Duet account'}`,
      onClose: closeSheet,
      full: true
    },
    h(
      'div',
      { class: 'settings-body' },
      h(
        'button',
        { type: 'button', class: 'profile-card', onClick: () => openSheet('editProfile', { returnTo: 'settings' }) },
        h(Avatar, { name, color: user.avatarColor || 0, size: 'lg' }),
        h(
          'div',
          { class: 'grow' },
          h('p', { class: 'profile-name' }, name),
          h('p', { class: 'profile-sub' }, user.username ? `@${user.username}` : 'Signed in to Duet'),
          h('p', { class: 'profile-sub' }, 'Edit display name and avatar')
        ),
        h(Icon, { name: 'chevron-right', size: 19, class: 'faint' })
      ),

      app.vault.keyError
        ? h(Banner, { tone: 'warn', icon: 'key', title: 'Encryption keys not published' }, truncate(app.vault.keyError, 140))
        : null,

      h(
        Group,
        { title: 'Appearance' },
        h(
          'div',
          { class: 'set-row' },
          h(
            'div',
            { class: 'set-row-main' },
            h('p', { class: 'set-row-title' }, 'Theme'),
            h('p', { class: 'set-row-sub' }, 'Duet follows your system unless you choose otherwise.'),
            h(
              'div',
              { class: 'mt-8' },
              h(Segmented, {
                label: 'Theme',
                value: app.settings.theme,
                options: THEME_OPTIONS,
                onChange: (value) => updateSettings({ theme: value })
              })
            )
          )
        ),
        h(
          Row,
          { icon: 'clock', title: 'Auto-lock', sub: 'Lock the vault after a period of inactivity.' },
          h(
            'select',
            {
              class: 'select',
              value: String(app.settings.autoLockMinutes),
              'aria-label': 'Auto-lock timeout',
              onChange: (event) => updateSettings({ autoLockMinutes: Number(event.target.value) })
            },
            LOCK_OPTIONS.map((option) => h('option', { key: option.value, value: String(option.value) }, option.label))
          )
        ),
        h(
          Row,
          {
            icon: 'reply',
            title: 'Enter sends a message',
            sub: 'Turn off to use Enter for a new line and send with the button.'
          },
          h(Switch, {
            checked: Boolean(app.settings.enterToSend),
            label: 'Enter sends a message',
            onChange: (value) => updateSettings({ enterToSend: value })
          })
        )
      ),

      h(
        Group,
        { title: 'Privacy' },
        h(
          Row,
          {
            icon: 'bell-off',
            title: 'Hide message previews',
            sub: 'Chat list and notifications show no message text.'
          },
          h(Switch, {
            checked: Boolean(app.settings.hidePreviews),
            label: 'Hide message previews',
            onChange: (value) => updateSettings({ hidePreviews: value })
          })
        ),
        h(
          Row,
          {
            icon: 'users',
            title: 'Share presence',
            sub: 'Let your contact see when you are online and your last seen time.'
          },
          h(Switch, {
            checked: Boolean(app.settings.presenceVisible),
            label: 'Share presence',
            onChange: (value) => updateSettings({ presenceVisible: value })
          })
        ),
        h(
          Row,
          {
            icon: 'trash',
            title: 'Confirm before deleting',
            sub: 'Ask before a message or conversation is deleted on the server.'
          },
          h(Switch, {
            checked: Boolean(app.settings.confirmDelete),
            label: 'Confirm before deleting',
            onChange: (value) => updateSettings({ confirmDelete: value })
          })
        )
      ),

      h(
        Group,
        { title: 'Notifications' },
        h(
          Row,
          {
            icon: 'bell',
            title: 'Web push',
            sub: push.supported
              ? (push.permission === 'denied'
                  ? 'Blocked in your browser settings.'
                  : 'Opaque alerts: the push service never sees message text.')
              : push.reason
          },
          h(Switch, {
            checked: Boolean(app.settings.notifications) && push.permission === 'granted',
            disabled: pushBusy || !push.supported || push.permission === 'denied',
            label: 'Web push notifications',
            onChange: onNotify
          })
        ),
        app.canInstall
          ? h(Row, {
              icon: 'download',
              title: 'Install Duet',
              sub: 'Add Duet to your home screen for a full-screen, offline-tolerant app.',
              onClick: () => import('./store.js').then(({ promptInstall }) => promptInstall())
            }, h(Icon, { name: 'chevron-right', size: 18, class: 'faint' }))
          : null
      ),

      h(
        Group,
        { title: 'Security' },
        h(Row, {
          icon: 'key',
          title: 'Change PIN or passphrase',
          sub: 'The master key is not derived from your PIN; changing it only re-wraps the vault.',
          onClick: () => openSheet('changePin', { returnTo: 'settings' })
        }, h(Icon, { name: 'chevron-right', size: 18, class: 'faint' })),
        h(
          Row,
          {
            icon: 'fingerprint',
            title: 'Biometric unlock',
            sub: biometrics.available
              ? (app.vault.biometric ? 'A passkey on this device can unlock the vault.' : 'Use a passkey with the WebAuthn PRF extension.')
              : (biometrics.reason || 'Checking this device…')
          },
          h(Switch, {
            checked: Boolean(app.vault.biometric),
            disabled: securityBusy || !biometrics.available,
            label: 'Biometric unlock',
            onChange: onBiometric
          })
        ),
        h(Row, {
          icon: 'restore',
          title: 'Replace recovery key',
          sub: app.vault.lastBackupAt
            ? `Encrypted key backup saved ${formatRelative(app.vault.lastBackupAt)}.`
            : 'Create a fresh one-time key for restoring this account elsewhere.',
          onClick: () => openSheet('regenerateRecoveryConfirm', { returnTo: 'settings' })
        }, h(Icon, { name: 'chevron-right', size: 18, class: 'faint' })),
        h(Row, {
          icon: 'lock',
          title: 'Lock vault now',
          sub: 'Clear keys and decrypted copies from memory.',
          onClick: () => lockVault('manual')
        }, h(Icon, { name: 'chevron-right', size: 18, class: 'faint' }))
      ),

      h(
        Group,
        { title: 'Devices & sessions' },
        app.sessions.length
          ? app.sessions.map((session) => h(SessionRow, { key: session.id, session }))
          : h('div', { class: 'set-row' }, h('p', { class: 'set-row-sub' }, 'Loading signed-in devices…')),
        h(Row, {
          icon: 'log-out',
          title: 'Sign out of all devices',
          sub: 'Every session on this account is revoked, including this one.',
          danger: true,
          onClick: () => openSheet('signOutAllConfirm', { returnTo: 'settings' })
        }, h(Icon, { name: 'chevron-right', size: 18, class: 'faint' }))
      ),

      h(
        Group,
        { title: 'This device' },
        h(
          Row,
          {
            icon: 'smartphone',
            title: 'Local storage',
            sub: storage.quota
              ? `${humanSize(storage.usage)} used of about ${humanSize(storage.quota)}`
              : `${humanSize(storage.usage)} of encrypted cache`
          },
          h('span', { class: 'chip' }, `${percent}%`)
        ),
        h(Row, {
          icon: 'trash',
          title: 'Remove decrypted copies',
          sub: 'Keep your keys, but clear cached plaintext and media from this device.',
          onClick: async () => {
            try {
              await clearDecryptedCache();
            } catch (error) {
              toastError(error);
            }
          }
        }, h(Icon, { name: 'chevron-right', size: 18, class: 'faint' })),
        h(Row, {
          icon: 'key',
          title: 'Back up keys now',
          sub: app.vault.lastBackupAt
            ? `Last backup ${formatRelative(app.vault.lastBackupAt)}.`
            : 'Upload a recovery-key-wrapped copy of your encrypted keystore.',
          onClick: () => backupNow()
        }, h(Icon, { name: 'chevron-right', size: 18, class: 'faint' })),
        h(Row, {
          icon: 'alert',
          title: 'Remove keys from this device',
          sub: 'Sign out and delete the local vault. Restoring later needs your recovery key.',
          danger: true,
          onClick: () => openSheet('removeKeysConfirm', { returnTo: 'settings' })
        }, h(Icon, { name: 'chevron-right', size: 18, class: 'faint' }))
      ),

      h(
        Group,
        { title: 'Diagnostics' },
        h(
          Row,
          {
            icon: 'info',
            title: 'Anonymous tracing',
            sub: 'Session and decrypt events only. Ids and counters, never message content.'
          },
          h(Switch, {
            checked: Boolean(app.settings.diagnostics),
            label: 'Anonymous diagnostics',
            onChange: (enabled) => toggleDiagnostics(enabled)
          })
        ),
        h(Row, {
          icon: 'download',
          title: 'Export diagnostics',
          sub: 'A text file with this device’s recent protocol events and build tag.',
          onClick: () => {
            const text = exportDiagnostics();
            downloadText(text, `duet-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`);
          }
        }, h(Icon, { name: 'chevron-right', size: 18, class: 'faint' }))
      ),

      h(
        Group,
        { title: 'About' },
        h(Row, {
          icon: 'shield',
          title: 'How Duet protects you',
          sub: 'Protocol, threat model and what the server can see.',
          onClick: () => openSheet('about', { returnTo: 'settings' })
        }, h(Icon, { name: 'chevron-right', size: 18, class: 'faint' }))
      ),

      h(Row, {
        icon: 'log-out',
        title: 'Sign out',
        sub: 'Your keys stay on this device. The vault stays locked.',
        danger: true,
        onClick: () => openSheet('signOutConfirm', { returnTo: 'settings' })
      }),

      h(
        'p',
        { class: 'settings-foot' },
        'Duet ',
        app.build ? h('span', { class: 'mono' }, app.build) : null,
        h('br'),
        'X3DH + Double Ratchet · XChaCha20-Poly1305'
      )
    )
  );
}

function SessionRow({ session }) {
  const title = describeAgent(session.userAgent);
  return h(
    'div',
    { class: 'session-item' },
    h('span', { class: 'set-icon' }, h(Icon, { name: 'smartphone', size: 16 })),
    h(
      'div',
      { class: 'grow' },
      h('p', { class: 'ua' }, title),
      h(
        'p',
        { class: 'meta' },
        session.current ? 'This device · ' : '',
        session.lastUsedAt || session.createdAt ? `Active ${formatRelative(session.lastUsedAt || session.createdAt)}` : 'Signed in',
        session.ip ? ` · ${session.ip}` : ''
      )
    ),
    session.current ? h('span', { class: 'chip ok' }, 'Current') : null
  );
}

function describeAgent(agent) {
  const text = String(agent || '');
  if (!text) return 'Unknown browser';
  const browser = /Firefox\//.test(text) ? 'Firefox'
    : /Edg\//.test(text) ? 'Edge'
      : /Chrome\//.test(text) ? 'Chrome'
        : /Safari\//.test(text) ? 'Safari'
          : 'Browser';
  const os = /iPhone|iPad/.test(text) ? 'iOS'
    : /Android/.test(text) ? 'Android'
      : /Macintosh/.test(text) ? 'macOS'
        : /Windows/.test(text) ? 'Windows'
          : /Linux/.test(text) ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

/* -------------------------------------------------------------------------- */
/* Change PIN sheet                                                           */
/* -------------------------------------------------------------------------- */

export function ChangePinSheet() {
  const app = useApp();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const valid = pin.length >= 6;
  const matches = pin === confirm;

  const submit = async (event) => {
    event.preventDefault();
    if (!valid || !matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await changePin(pin);
      closeSheetWithReturn();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return h(
    Sheet,
    {
      title: 'Change PIN',
      subtitle: 'Re-wraps your vault key on this device.',
      onClose: closeSheetWithReturn,
      wide: true,
      footer: h(Button, { type: 'submit', form: 'change-pin-form', loading: busy, disabled: !valid || !matches }, 'Update PIN')
    },
    h(
      'form',
      { id: 'change-pin-form', class: 'stack-16', onSubmit: submit },
      h(Banner, { tone: 'info', icon: 'info' }, 'Your encryption keys are not regenerated. Only the local wrapper around your master key changes.'),
      h(
        Field,
        { label: 'New PIN or passphrase', htmlFor: 'new-pin-value', hint: 'At least 6 digits, or 8+ characters for a passphrase.' },
        h(
          'div',
          { class: 'input-wrap' },
          h('input', {
            id: 'new-pin-value',
            class: 'input',
            type: show ? 'text' : 'password',
            inputmode: 'numeric',
            autocomplete: 'new-password',
            value: pin,
            maxlength: '128',
            onInput: (event) => setPin(event.target.value)
          }),
          h('span', { class: 'trail' }, h('button', {
            type: 'button',
            class: 'icon-btn sm',
            'aria-label': show ? 'Hide' : 'Show',
            onClick: () => setShow((value) => !value)
          }, h(Icon, { name: show ? 'eye-off' : 'eye', size: 18 })))
        )
      ),
      h(
        Field,
        {
          label: 'Confirm new PIN',
          htmlFor: 'new-pin-confirm-value',
          error: confirm && !matches ? 'Those entries do not match.' : null
        },
        h('input', {
          id: 'new-pin-confirm-value',
          class: 'input',
          type: show ? 'text' : 'password',
          inputmode: 'numeric',
          autocomplete: 'new-password',
          value: confirm,
          maxlength: '128',
          onInput: (event) => setConfirm(event.target.value)
        })
      ),
      error ? h('p', { class: 'error-text', role: 'alert' }, error) : null
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function toastError(error) {
  toast(errorMessage(error), { tone: 'danger' });
}

export function closeSheetWithReturn() {
  const back = state.sheets.returnTo;
  if (back) openSheet(back);
  else closeSheet();
}
