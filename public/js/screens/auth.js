import { h, useEffect, useRef, useState } from '../preact.js';
import {
  Avatar,
  Banner,
  Button,
  Field,
  LinkButton,
  Spinner,
  useCopy,
  useInterval
} from '../ui.js';
import { Icon, LogoMark } from '../icons.js';
import {
  errorMessage,
  finishRecovery,
  finishVaultSetup,
  getVault,
  openSheet,
  promptInstall,
  register,
  login,
  restoreVault,
  saveProfile,
  setPhase,
  setupVault,
  signOut,
  state,
  unlockBiometric,
  unlockVault,
  useApp,
} from '../store.js';
import { biometricAvailability, normalizeRecoverySecret } from '../vault.js';
import { recoveryGroups } from '../crypto.js';
import { downloadText, formatDuration } from '../util.js';

/* -------------------------------------------------------------------------- */
/* Shell                                                                      */
/* -------------------------------------------------------------------------- */

function AuthShell({ children, wide = false, top = null, footer = null }) {
  return h(
    'div',
    { class: 'screen auth' },
    h(
      'div',
      { class: 'auth-top' },
      h(
        'div',
        { class: 'brand' },
        h(LogoMark, { size: 34 }),
        h(
          'div',
          null,
          h('div', { class: 'brand-word' }, 'Duet'),
          h('div', { class: 'brand-sub' }, 'for two')
        )
      ),
      top
    ),
    h('div', { class: `auth-main${wide ? ' auth-wide' : ''}` }, children),
    footer || h('p', { class: 'auth-foot' }, 'End-to-end encrypted. Your keys never leave this device.')
  );
}

/* -------------------------------------------------------------------------- */
/* Welcome                                                                    */
/* -------------------------------------------------------------------------- */

export function WelcomeScreen() {
  const app = useApp();
  const bootError = app.bootError;

  return h(
    'div',
    { class: 'screen auth' },
    h(
      'div',
      { class: 'auth-top' },
      h(
        'div',
        { class: 'brand' },
        h(LogoMark, { size: 36 }),
        h(
          'div',
          null,
          h('div', { class: 'brand-word' }, 'Duet'),
          h('div', { class: 'brand-sub' }, 'for two')
        )
      ),
      h('span', { class: 'chip accent' }, h(Icon, { name: 'lock', size: 13 }), 'Private')
    ),
    h(
      'div',
      { class: 'auth-main' },
      h(
        'div',
        { class: 'hero' },
        h('span', { class: 'hero-kicker' }, h(Icon, { name: 'sparkle', size: 14 }), 'One conversation, two people'),
        h('h1', { class: 'hero-title' }, 'A quiet place ', h('em', null, 'for two.'), ' No audience.'),
        h('p', { class: 'hero-sub' }, 'Duet is a private messenger built for exactly two people. Messages, photos and videos are encrypted on your device before they ever reach the server.'),
        bootError ? h('div', { class: 'mt-20' }, h(Banner, { tone: 'warn', icon: 'alert', title: 'Could not reach Duet' }, bootError)) : null
      ),
      h(
        'div',
        { class: 'feature-list' },
        h(Feature, {
          icon: 'key',
          title: 'Your keys, your device',
          text: 'A local vault seals your encryption keys with a PIN, biometrics and a recovery key.'
        }),
        h(Feature, {
          icon: 'shield-check',
          title: 'The server cannot read anything',
          text: 'It relays ciphertext and public keys. It never sees a message, a photo or a filename.'
        }),
        h(Feature, {
          icon: 'smartphone',
          title: 'Installable and offline-tolerant',
          text: 'Add Duet to your home screen. Recent conversations stay readable without a connection.'
        })
      ),
      h(
        'div',
        { class: 'auth-actions' },
        app.pendingInvite
          ? h(Banner, { tone: 'info', icon: 'link', title: 'You have an invite' }, 'Sign in or create your account to accept it. Invites create the conversation without sharing a phone number.')
          : null,
        h(Button, { size: 'lg', block: true, onClick: () => setPhase('login'), iconRight: 'arrow-right' }, 'Sign in'),
        h(Button, { variant: 'secondary', size: 'lg', block: true, onClick: () => setPhase('register') }, 'Create account'),
        app.canInstall
          ? h(Button, { variant: 'secondary', size: 'lg', block: true, icon: 'download', onClick: () => promptInstall() }, 'Install Duet')
          : null
      ),
      h(
        'p',
        { class: 'trust-foot' },
        h(Icon, { name: 'info', size: 15 }),
        h('span', null, 'No phone number required. Just a username and password. Then a local vault only you can open.')
      )
    ),
    h(
      'p',
      { class: 'auth-foot' },
      'By continuing you agree to keep your recovery key somewhere safe. ',
      h(LinkButton, { onClick: () => openSheet('about') }, 'How Duet protects you')
    )
  );
}

function Feature({ icon, title, text }) {
  return h(
    'div',
    { class: 'feature-row' },
    h('span', { class: 'feature-icon' }, h(Icon, { name: icon, size: 18 })),
    h('div', null, h('p', { class: 'feature-title' }, title), h('p', { class: 'feature-sub' }, text))
  );
}

/* -------------------------------------------------------------------------- */
/* Login                                                                      */
/* -------------------------------------------------------------------------- */

export function LoginScreen() {
  const app = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const canSubmit = username.length >= 3 && password.length >= 8 && !app.busy;

  const submit = async (event) => {
    event?.preventDefault();
    if (!canSubmit) return;
    setError(null);
    try {
      await login(username.toLowerCase().trim(), password);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return h(
    AuthShell,
    {
      top: h(LinkButton, { onClick: () => setPhase('welcome') }, 'Back'),
      footer: h('p', { class: 'auth-foot' }, 'Your username and password never leave this device unencrypted.')
    },
    h(
      'form',
      { class: 'stack-20', onSubmit: submit },
      h(
        'div',
        null,
        h('h1', { class: 'h1' }, 'Welcome back'),
        h('p', { class: 'muted mt-8' }, 'Enter your username and password to unlock your vault.')
      ),
      h(
        Field,
        { label: 'Username', htmlFor: 'username' },
        h('input', {
          id: 'username',
          ref: inputRef,
          class: 'input',
          type: 'text',
          inputmode: 'text',
          autocomplete: 'username',
          placeholder: 'yourusername',
          value: username,
          maxlength: '32',
          onInput: (event) => setUsername(event.target.value.toLowerCase())
        })
      ),
      h(
        Field,
        { label: 'Password', htmlFor: 'password' },
        h(
          'div',
          { class: 'input-wrap' },
          h('input', {
            id: 'password',
            class: 'input',
            type: showPassword ? 'text' : 'password',
            autocomplete: 'current-password',
            placeholder: '••••••••',
            value: password,
            maxlength: '128',
            onInput: (event) => setPassword(event.target.value)
          }),
          h('span', { class: 'trail' }, h('button', {
            type: 'button',
            class: 'icon-btn sm',
            'aria-label': showPassword ? 'Hide' : 'Show',
            onClick: () => setShowPassword((value) => !value)
          }, h(Icon, { name: showPassword ? 'eye-off' : 'eye', size: 18 })))
        )
      ),
      error ? h('p', { class: 'error-text', role: 'alert' }, error) : null,
      h(Button, { type: 'submit', size: 'lg', block: true, loading: app.busy, disabled: !canSubmit }, 'Sign in'),
      h(
        'div',
        { class: 'between' },
        h(LinkButton, { onClick: () => setPhase('welcome') }, 'Back to welcome'),
        h(LinkButton, { onClick: () => setPhase('register') }, 'Create account')
      )
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Register                                                                   */
/* -------------------------------------------------------------------------- */

export function RegisterScreen() {
  const app = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatarColor, setAvatarColor] = useState(0);
  const [error, setError] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const inputRef = useRef(null);

  const AVATAR_COLORS = [0, 1, 2, 3, 4, 5, 6, 7];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const usernameValid = username.length >= 3 && /^[a-zA-Z0-9_.-]{3,32}$/.test(username);
  const passwordValid = password.length >= 8;
  const passwordsMatch = password === confirmPassword;
  const canSubmit = usernameValid && passwordValid && passwordsMatch && !app.busy;

  const submit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    try {
      await register(username.toLowerCase().trim(), password, displayName.trim() || null, avatarColor);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return h(
    AuthShell,
    {
      wide: true,
      top: h(LinkButton, { onClick: () => setPhase('welcome') }, 'Back'),
      footer: h('p', { class: 'auth-foot' }, 'Your username and password never leave this device unencrypted.')
    },
    h(
      'form',
      { class: 'stack-20', onSubmit: submit },
      h(
        'div',
        null,
        h('h1', { class: 'h1' }, 'Create your account'),
        h('p', { class: 'muted mt-8' }, 'Choose a username and password. No phone number required.')
      ),
      h(
        Field,
        { label: 'Username', htmlFor: 'reg-username', error: username && !usernameValid ? '3-32 characters: letters, numbers, underscore, dash, dot' : null },
        h('input', {
          id: 'reg-username',
          ref: inputRef,
          class: 'input',
          type: 'text',
          inputmode: 'text',
          autocomplete: 'username',
          placeholder: 'yourusername',
          value: username,
          maxlength: '32',
          onInput: (event) => setUsername(event.target.value.toLowerCase())
        })
      ),
      h(
        Field,
        { label: 'Password', htmlFor: 'reg-password', hint: 'At least 8 characters' },
        h(
          'div',
          { class: 'input-wrap' },
          h('input', {
            id: 'reg-password',
            class: 'input',
            type: showPassword ? 'text' : 'password',
            autocomplete: 'new-password',
            placeholder: '••••••••',
            value: password,
            maxlength: '128',
            onInput: (event) => setPassword(event.target.value)
          }),
          h('span', { class: 'trail' }, h('button', {
            type: 'button',
            class: 'icon-btn sm',
            'aria-label': showPassword ? 'Hide' : 'Show',
            onClick: () => setShowPassword((value) => !value)
          }, h(Icon, { name: showPassword ? 'eye-off' : 'eye', size: 18 })))
        )
      ),
      h(
        Field,
        { label: 'Confirm password', htmlFor: 'reg-confirm', error: confirmPassword && !passwordsMatch ? 'Passwords do not match' : null },
        h('input', {
          id: 'reg-confirm',
          class: 'input',
          type: showPassword ? 'text' : 'password',
          autocomplete: 'new-password',
          placeholder: '••••••••',
          value: confirmPassword,
          maxlength: '128',
          onInput: (event) => setConfirmPassword(event.target.value)
        })
      ),
      h(
        Field,
        { label: 'Display name (optional)', htmlFor: 'reg-display-name' },
        h('input', {
          id: 'reg-display-name',
          class: 'input',
          type: 'text',
          autocomplete: 'nickname',
          placeholder: 'Your name',
          value: displayName,
          maxlength: '40',
          onInput: (event) => setDisplayName(event.target.value)
        })
      ),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'label' }, 'Avatar colour'),
        h(
          'div',
          { class: 'swatches', role: 'group', 'aria-label': 'Avatar colour' },
          AVATAR_COLORS.map((value) => h('button', {
            key: value,
            type: 'button',
            class: `swatch${value === avatarColor ? ' active' : ''}`,
            'data-color': value,
            'aria-label': `Colour ${value + 1}`,
            'aria-pressed': value === avatarColor ? 'true' : 'false',
            onClick: () => setAvatarColor(value)
          }))
        )
      ),
      error ? h('p', { class: 'error-text', role: 'alert' }, error) : null,
      h(Button, { type: 'submit', size: 'lg', block: true, loading: app.busy, disabled: !canSubmit }, 'Create account'),
      h(
        'p',
        { class: 'hint' },
        h(Icon, { name: 'alert', size: 14 }),
        ' Your username and password are used to sign in. The vault is protected by a separate PIN.'
      )
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Profile                                                                    */
/* -------------------------------------------------------------------------- */

export function ProfileScreen() {
  const app = useApp();
  const [name, setName] = useState(app.profile.name || app.auth.user?.displayName || '');
  const [color, setColor] = useState(Number(app.profile.color ?? app.auth.user?.avatarColor ?? 0));
  const [error, setError] = useState(null);
  const trimmed = name.trim();

  const submit = async (event) => {
    event.preventDefault();
    if (!trimmed || app.busy) return;
    setError(null);
    try {
      await saveProfile(trimmed, color);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return h(
    AuthShell,
    { top: h(LinkButton, { onClick: signOut }, 'Sign out') },
    h(
      'form',
      { class: 'stack-20', onSubmit: submit },
      h(
        'div',
        null,
        h('div', { class: 'step-dots mb-16' }, h('span', { class: 'step-dot on' }), h('span', { class: 'step-dot on' }), h('span', { class: 'step-dot on' })),
        h('h1', { class: 'h1' }, app.auth.isNew ? 'Welcome to Duet' : 'Your profile'),
        h('p', { class: 'muted mt-8' }, 'This is the name your contact sees.')
      ),
      h(
        'div',
        { class: 'avatar-picker' },
        h(Avatar, { name: trimmed || '?', color, size: 'xl' }),
        h(
          'div',
          { class: 'grow' },
          h('p', { class: 'strong' }, trimmed || 'Your name'),
          h('p', { class: 'small faint mt-4' }, 'Pick a colour for your avatar.')
        )
      ),
      h(
        Field,
        { label: 'Display name', htmlFor: 'display-name' },
        h('input', {
          id: 'display-name',
          class: 'input',
          value: name,
          maxlength: '40',
          autocomplete: 'nickname',
          placeholder: 'Your name',
          required: true,
          onInput: (event) => setName(event.target.value)
        })
      ),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'label' }, 'Avatar colour'),
        h(
          'div',
          { class: 'swatches', role: 'group', 'aria-label': 'Avatar colour' },
          [0, 1, 2, 3, 4, 5, 6, 7].map((value) => h('button', {
            key: value,
            type: 'button',
            class: `swatch${value === color ? ' active' : ''}`,
            'data-color': value,
            'aria-label': `Colour ${value + 1}`,
            'aria-pressed': value === color ? 'true' : 'false',
            onClick: () => setColor(value)
          }))
        )
      ),
      error ? h('p', { class: 'error-text', role: 'alert' }, error) : null,
      h(Button, { type: 'submit', size: 'lg', block: true, loading: app.busy, disabled: !trimmed }, 'Continue')
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Vault setup                                                                */
/* -------------------------------------------------------------------------- */

function useBiometrics() {
  const [status, setStatus] = useState({ available: false, reason: null, checked: false });
  useEffect(() => {
    let cancelled = false;
    biometricAvailability().then((result) => {
      if (!cancelled) setStatus({ ...result, checked: true });
    }).catch(() => {
      if (!cancelled) setStatus({ available: false, reason: 'Biometric unlock is unavailable.', checked: true });
    });
    return () => { cancelled = true; };
  }, []);
  return status;
}

export function VaultSetupScreen() {
  const app = useApp();
  const biometrics = useBiometrics();
  const [passphrase, setPassphrase] = useState(false);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [biometric, setBiometric] = useState(false);
  const [error, setError] = useState(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!biometrics.available) setBiometric(false);
  }, [biometrics.available]);

  const validLength = passphrase ? pin.length >= 8 : pin.length >= 6;
  const matches = pin === confirm;
  const canSubmit = validLength && matches && !app.busy;

  const submit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    try {
      await setupVault({ pin, biometric });
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return h(
    AuthShell,
    {
      wide: true,
      top: h(LinkButton, { onClick: signOut }, 'Sign out'),
      footer: h('p', { class: 'auth-foot' }, 'The vault lives on this device. Duet uploads only an encrypted key backup so you can restore on another device.')
    },
    h(
      'form',
      { class: 'stack-20', onSubmit: submit },
      h(
        'div',
        null,
        h('div', { class: 'vault-art' }, h(Icon, { name: 'lock', size: 30 })),
        h('h1', { class: 'h1' }, 'Create your vault'),
        h('p', { class: 'muted mt-8' }, 'Your encryption keys are generated here, then sealed with a key only you know. The server never receives the password.')
      ),
      h(
        'div',
        { class: 'vault-points' },
        h(VaultPoint, { text: 'A random master key is wrapped by your PIN or passphrase using scrypt.' }),
        h(VaultPoint, { text: 'Biometrics can unlock it too, using the WebAuthn PRF extension where supported.' }),
        h(VaultPoint, { text: 'A one-time recovery key is your only way back if you forget the PIN.' })
      ),
      h(
        'div',
        { class: 'between' },
        h('span', { class: 'label' }, passphrase ? 'Passphrase' : 'PIN'),
        h(LinkButton, { onClick: () => {
          setPassphrase((value) => !value);
          setPin('');
          setConfirm('');
          setError(null);
        } }, passphrase ? 'Use a 6-digit PIN' : 'Use a passphrase instead')
      ),
      h(
        Field,
        {
          label: passphrase ? 'Passphrase' : 'PIN',
          htmlFor: 'vault-pin',
          hint: passphrase ? 'At least 8 characters. Longer is stronger.' : 'At least 6 digits. Avoid birthdays and repeated digits.'
        },
        h(
          'div',
          { class: 'input-wrap' },
          h('input', {
            id: 'vault-pin',
            class: 'input',
            type: show ? 'text' : 'password',
            inputmode: passphrase ? 'text' : 'numeric',
            autocomplete: 'new-password',
            value: pin,
            maxlength: '128',
            onInput: (event) => setPin(event.target.value),
            'aria-invalid': pin && !validLength ? 'true' : undefined
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
          label: 'Confirm',
          htmlFor: 'vault-pin-confirm',
          error: confirm && !matches ? 'Those entries do not match.' : null
        },
        h('input', {
          id: 'vault-pin-confirm',
          class: 'input',
          type: show ? 'text' : 'password',
          inputmode: passphrase ? 'text' : 'numeric',
          autocomplete: 'new-password',
          value: confirm,
          maxlength: '128',
          onInput: (event) => setConfirm(event.target.value)
        })
      ),
      biometrics.available
        ? h(
            'div',
            { class: 'set-card' },
            h(
              'div',
              { class: 'set-row' },
              h('span', { class: 'set-icon' }, h(Icon, { name: 'fingerprint', size: 17 })),
              h(
                'div',
                { class: 'set-row-main' },
                h('p', { class: 'set-row-title' }, 'Unlock with biometrics'),
                h('p', { class: 'set-row-sub' }, 'Uses your device passkey and the PRF extension. The PIN still works.')
              ),
              h(SwitchLike, { checked: biometric, onChange: setBiometric, label: 'Unlock with biometrics' })
            )
          )
        : null,
      app.setup.status
        ? h('div', { class: 'row gap-8 hint' }, h(Spinner), h('span', null, app.setup.status))
        : null,
      error || app.setup.error
        ? h('p', { class: 'error-text', role: 'alert' }, error || app.setup.error)
        : null,
      h(Button, { type: 'submit', size: 'lg', block: true, loading: app.busy, disabled: !canSubmit }, 'Create vault'),
      h(
        'p',
        { class: 'hint' },
        h(Icon, { name: 'alert', size: 14 }),
        ' If you lose both your PIN and your recovery key, no one — including the server operator — can recover your messages.'
      )
    )
  );
}

function VaultPoint({ text }) {
  return h('div', { class: 'vault-point' }, h(Icon, { name: 'check', size: 16 }), h('span', null, text));
}

function SwitchLike({ checked, onChange, label }) {
  return h('button', {
    type: 'button',
    class: 'switch',
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': label,
    onClick: () => onChange(!checked)
  });
}

/* -------------------------------------------------------------------------- */
/* Recovery key after setup                                                   */
/* -------------------------------------------------------------------------- */

export function VaultRecoveryKeyScreen() {
  const app = useApp();
  const [saved, setSaved] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [copied, copy] = useCopy();
  const secret = app.recovery.secret;
  const pretty = recoveryGroups(secret || '');

  if (!secret) {
    return h(
      AuthShell,
      { wide: true },
      h(
        'div',
        { class: 'stack-20' },
        h(Banner, { tone: 'warn', icon: 'alert', title: 'No recovery key in this session' }, 'For security, the key is shown once. If you did not save it, replace it from Settings after unlocking.'),
        h(Button, { size: 'lg', block: true, onClick: () => finishVaultSetup() }, 'Continue to Duet')
      )
    );
  }

  const download = () => {
    const text = [
      'Duet recovery key',
      '=================',
      '',
      pretty,
      '',
      `Account: ${app.auth.user?.username || 'your Duet account'}`,
      `Created: ${new Date().toISOString()}`,
      '',
      'This key is the only way to restore your encrypted keys on another device.',
      'Keep it offline. Anyone with this key can open a backup of your keys.',
      'Duet support cannot recover it for you.'
    ].join('\n');
    downloadText(text, 'duet-recovery-key.txt');
    setSaved(true);
  };

  return h(
    AuthShell,
    {
      wide: true,
      footer: h('p', { class: 'auth-foot' }, 'You can replace this key later from Settings → Security. Replacing it does not change past messages.')
    },
    h(
      'div',
      { class: 'stack-20' },
      h(
        'div',
        null,
        h('div', { class: 'vault-art' }, h(Icon, { name: 'key', size: 30 })),
        h('h1', { class: 'h1' }, 'Save your recovery key'),
        h('p', { class: 'muted mt-8' }, 'This is the only way back if you forget your PIN and lose this device. It is shown once — Duet stores only its wrapped form.')
      ),
      h(
        'div',
        { class: 'recovery-box' },
        h('p', { class: 'recovery-key' }, pretty),
        h(
          'div',
          { class: 'recovery-actions' },
          h(Button, { size: 'sm', variant: 'secondary', icon: copied ? 'check' : 'copy', onClick: () => copy(pretty) }, copied ? 'Copied' : 'Copy'),
          h(Button, { size: 'sm', variant: 'secondary', icon: 'download', onClick: download }, 'Download')
        )
      ),
      app.recovery.backupError
        ? h(Banner, { tone: 'warn', icon: 'alert', title: 'Key backup is pending' }, 'The encrypted backup could not be uploaded yet. Keep this recovery key safe; Duet will retry the backup.')
        : h(Banner, { tone: 'ok', icon: 'shield-check', title: 'Encrypted backup saved' }, 'A copy of your encrypted keys is on the server. Only this recovery key can open it.'),
      h(
        'div',
        { class: 'stack-10' },
        h(
          'label',
          { class: 'check-row' },
          h('input', { type: 'checkbox', checked: saved, onChange: (event) => setSaved(event.target.checked) }),
          h('span', null, 'I saved the recovery key somewhere offline.')
        ),
        h(
          'label',
          { class: 'check-row' },
          h('input', { type: 'checkbox', checked: understood, onChange: (event) => setUnderstood(event.target.checked) }),
          h('span', null, 'I understand Duet cannot recover my messages without this key.')
        )
      ),
      h(Button, {
        size: 'lg',
        block: true,
        loading: app.busy,
        disabled: !saved || !understood,
        onClick: () => finishVaultSetup()
      }, 'Open Duet')
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Lock                                                                       */
/* -------------------------------------------------------------------------- */

export function LockScreen() {
  const app = useApp();
  const [pin, setPin] = useState('');
  const [show, setShow] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [until, setUntil] = useState(0);
  const input = useRef(null);
  const biometrics = useBiometrics();

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    if (app.lock.retryAfter > 0) setUntil(Date.now() + app.lock.retryAfter * 1000);
  }, [app.lock.retryAfter]);

  useInterval(() => {
    setRemaining(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
  }, until ? 500 : 0);

  const blocked = remaining > 0;
  const name = app.auth.user?.displayName || 'Your vault';

  const submit = async (event) => {
    event?.preventDefault();
    if (!pin || app.lock.busy || blocked) return;
    await unlockVault(pin);
    setPin('');
  };

  return h(
    'div',
    { class: 'screen lock-screen' },
    h(
      'div',
      { class: 'lock-card' },
      h('span', { class: 'lock-art' }, h(Icon, { name: 'lock', size: 25 })),
      h(Avatar, { name, color: app.auth.user?.avatarColor || 0, size: 'lg', class: 'mb-8' }),
      h('h1', { class: 'h2' }, 'Welcome back'),
      h('p', { class: 'small muted mt-4' }, `${name}’s vault is locked on this device.`),
      h(
        'form',
        { class: 'stack-14 mt-20', onSubmit: submit, style: { width: '100%' } },
        h(
          'div',
          { class: 'input-wrap' },
          h('input', {
            ref: input,
            class: 'pin-input',
            type: show ? 'text' : 'password',
            inputmode: 'numeric',
            autocomplete: 'current-password',
            placeholder: 'PIN or passphrase',
            value: pin,
            maxlength: '128',
            'aria-label': 'PIN or passphrase',
            onInput: (event) => setPin(event.target.value)
          }),
          h('span', { class: 'trail', style: { right: '8px' } }, h('button', {
            type: 'button',
            class: 'icon-btn sm',
            'aria-label': show ? 'Hide' : 'Show',
            onClick: () => setShow((value) => !value)
          }, h(Icon, { name: show ? 'eye-off' : 'eye', size: 18 })))
        ),
        app.lock.error ? h('p', { class: 'error-text', role: 'alert' }, app.lock.error) : null,
        blocked ? h('p', { class: 'hint countdown' }, `Try again in ${formatDuration(remaining)}`) : null,
        h(Button, { type: 'submit', size: 'lg', block: true, loading: app.lock.busy, disabled: blocked || !pin }, 'Unlock'),
        app.vault.biometric && biometrics.available
          ? h(Button, {
              variant: 'secondary',
              size: 'lg',
              block: true,
              icon: 'fingerprint',
              disabled: blocked || app.lock.busy,
              onClick: () => unlockBiometric()
            }, 'Use biometrics')
          : null
      ),
      h(
        'div',
        { class: 'stack-10 mt-20', style: { width: '100%' } },
        h(LinkButton, {
          onClick: () => openSheet('restoreConfirm')
        }, 'Forgot your PIN? Use your recovery key'),
        h('div', { class: 'divider' }),
        h(LinkButton, { onClick: signOut }, 'Sign out of this account')
      )
    ),
    h('p', { class: 'auth-foot mt-20' }, 'Locked locally. Your keys are not in memory and decrypted copies are cleared.')
  );
}

/* -------------------------------------------------------------------------- */
/* Restore with recovery key                                                  */
/* -------------------------------------------------------------------------- */

export function VaultRestoreScreen() {
  const app = useApp();
  const [secret, setSecret] = useState('');
  const [error, setError] = useState(null);
  const normalized = normalizeRecoverySecret(secret);
  const ready = normalized.length === 24;

  const submit = async (event) => {
    event.preventDefault();
    if (!ready || app.busy) return;
    setError(null);
    try {
      await restoreVault(secret);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return h(
    AuthShell,
    {
      wide: true,
      top: app.vault.exists
        ? h(LinkButton, { onClick: () => setPhase('locked') }, 'Back to lock screen')
        : h(LinkButton, { onClick: signOut }, 'Sign out'),
      footer: h('p', { class: 'auth-foot' }, 'The encrypted backup is stored on the server but can only be opened with this key.')
    },
    h(
      'form',
      { class: 'stack-20', onSubmit: submit },
      h(
        'div',
        null,
        h('div', { class: 'vault-art' }, h(Icon, { name: 'restore', size: 30 })),
        h('h1', { class: 'h1' }, 'Restore your vault'),
        h('p', { class: 'muted mt-8' }, 'Enter the 24-character recovery key you saved when you created Duet. Hyphens and case do not matter.')
      ),
      app.vault.exists
        ? h(Banner, { tone: 'warn', icon: 'alert', title: 'This replaces the vault on this device' }, 'Existing local keys will be replaced by the encrypted backup. Only continue if you have the recovery key for this account.')
        : null,
      h(
        Field,
        {
          label: 'Recovery key',
          htmlFor: 'recovery-secret',
          hint: `${normalized.length} of 24 characters`,
          error
        },
        h('input', {
          id: 'recovery-secret',
          class: 'input mono',
          value: secret,
          placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX',
          autocomplete: 'off',
          autocapitalize: 'characters',
          spellcheck: 'false',
          maxlength: '40',
          onInput: (event) => setSecret(event.target.value),
          style: { letterSpacing: '0.08em', textAlign: 'center' }
        })
      ),
      h(Button, { type: 'submit', size: 'lg', block: true, loading: app.busy, disabled: !ready }, 'Restore keys'),
      h(Banner, { tone: 'info', icon: 'info' }, 'No backup? Duet cannot decrypt older messages without the original keys. You can create a fresh vault from Settings after signing in.')
    )
  );
}

export function VaultNewPinScreen() {
  const app = useApp();
  const biometrics = useBiometrics();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [biometric, setBiometric] = useState(false);
  const [error, setError] = useState(null);
  const validLength = pin.length >= 6;
  const matches = pin === confirm;
  const canSubmit = validLength && matches && !app.busy;

  useEffect(() => {
    if (!biometrics.available) setBiometric(false);
  }, [biometrics.available]);

  const submit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    try {
      await finishRecovery(pin, { biometric });
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return h(
    AuthShell,
    { wide: true, top: h(LinkButton, { onClick: signOut }, 'Sign out') },
    h(
      'form',
      { class: 'stack-20', onSubmit: submit },
      h(
        'div',
        null,
        h('div', { class: 'vault-art' }, h(Icon, { name: 'key', size: 30 })),
        h('h1', { class: 'h1' }, 'Choose a new PIN'),
        h('p', { class: 'muted mt-8' }, 'Your keys are restored. Pick a PIN for this device. The old PIN no longer works here.')
      ),
      h(
        Field,
        { label: 'New PIN', htmlFor: 'new-pin', hint: 'At least 6 digits.' },
        h('input', {
          id: 'new-pin',
          class: 'input',
          type: 'password',
          inputmode: 'numeric',
          autocomplete: 'new-password',
          value: pin,
          maxlength: '128',
          onInput: (event) => setPin(event.target.value)
        })
      ),
      h(
        Field,
        {
          label: 'Confirm PIN',
          htmlFor: 'new-pin-confirm',
          error: confirm && !matches ? 'Those entries do not match.' : null
        },
        h('input', {
          id: 'new-pin-confirm',
          class: 'input',
          type: 'password',
          inputmode: 'numeric',
          autocomplete: 'new-password',
          value: confirm,
          maxlength: '128',
          onInput: (event) => setConfirm(event.target.value)
        })
      ),
      biometrics.available
        ? h(
            'div',
            { class: 'set-card' },
            h(
              'div',
              { class: 'set-row' },
              h('span', { class: 'set-icon' }, h(Icon, { name: 'fingerprint', size: 17 })),
              h(
                'div',
                { class: 'set-row-main' },
                h('p', { class: 'set-row-title' }, 'Enable biometric unlock'),
                h('p', { class: 'set-row-sub' }, 'Optional. Your PIN still works as a fallback.')
              ),
              h(SwitchLike, { checked: biometric, onChange: setBiometric, label: 'Enable biometric unlock' })
            )
          )
        : null,
      error ? h('p', { class: 'error-text', role: 'alert' }, error) : null,
      h(Button, { type: 'submit', size: 'lg', block: true, loading: app.busy, disabled: !canSubmit }, 'Unlock Duet')
    )
  );
}