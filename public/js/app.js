import { Component, h, render, useEffect } from './preact.js';
import { ToastHost } from './ui.js';
import { LogoMark } from './icons.js';
import { MediaViewer, SheetHost } from './sheets.js';
import {
  WelcomeScreen,
  LoginScreen,
  RegisterScreen,
  ProfileScreen,
  VaultSetupScreen,
  VaultRecoveryKeyScreen,
  LockScreen,
  VaultRestoreScreen,
  VaultNewPinScreen
} from './screens/auth.js';
import { HomeScreen } from './screens/home.js';
import { ChatScreen } from './screens/chat.js';
import {
  boot,
  dismissToast,
  parseInviteFromLocation,
  storePendingInvite,
  useApp
} from './store.js';
import { registerServiceWorker } from './push.js';

const PHASES = {
  welcome: WelcomeScreen,
  login: LoginScreen,
  register: RegisterScreen,
  profile: ProfileScreen,
  'vault-setup': VaultSetupScreen,
  'vault-recovery-key': VaultRecoveryKeyScreen,
  locked: LockScreen,
  'vault-restore': VaultRestoreScreen,
  'vault-new-pin': VaultNewPinScreen,
  home: HomeScreen,
  chat: ChatScreen
};

/* -------------------------------------------------------------------------- */
/* Boot splash                                                                */
/* -------------------------------------------------------------------------- */

function BootScreen({ message = 'Opening Duet' }) {
  return h(
    'div',
    { class: 'boot-splash', role: 'status', 'aria-live': 'polite' },
    h(LogoMark, { size: 64 }),
    h('p', { class: 'boot-word' }, 'Duet'),
    h('span', { class: 'spinner', 'aria-label': message }),
    message !== 'Opening Duet' ? h('p', { class: 'hint' }, message) : null
  );
}

/* -------------------------------------------------------------------------- */
/* Error boundary                                                             */
/* -------------------------------------------------------------------------- */

class ErrorBoundary extends Component {
  constructor() {
    super();
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error('Duet crashed', error);
  }

  render() {
    if (this.state.error) {
      return h(
        'div',
        { class: 'screen auth' },
        h(
          'div',
          { class: 'auth-main' },
          h(
            'div',
            { class: 'auth-card stack-16' },
            h(LogoMark, { size: 44 }),
            h('h1', { class: 'h2' }, 'Duet hit an unexpected error'),
            h(
              'p',
              { class: 'small muted' },
              'Your vault was not changed. Reload to reopen it. If this keeps happening, export diagnostics from Settings before reloading.'
            ),
            h(
              'p',
              { class: 'mono tiny faint wrap-anywhere' },
              String(this.state.error?.message || this.state.error)
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-primary btn-block btn-lg',
                onClick: () => window.location.reload()
              },
              'Reload Duet'
            )
          )
        )
      );
    }
    return this.props.children;
  }
}

/* -------------------------------------------------------------------------- */
/* Root                                                                       */
/* -------------------------------------------------------------------------- */

function Root() {
  const app = useApp();
  const phase = app.phase || 'booting';
  const Screen = PHASES[phase];

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      try {
        await registerServiceWorker();
      } catch { /* the app runs without offline caching */ }
      if (!cancelled) await boot();
    };
    void start();

    const onHash = () => {
      const token = parseInviteFromLocation();
      if (token) storePendingInvite(token);
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  return h(
    'div',
    { class: 'app-frame' },
    Screen
      ? h(Screen)
      : h(BootScreen, {
          message: phase === 'booting' ? 'Opening Duet' : 'Preparing…'
        }),
    h(SheetHost),
    h(MediaViewer),
    h(ToastHost, {
      toasts: app.toasts,
      onDismiss: dismissToast
    })
  );
}

export function App() {
  return h(ErrorBoundary, null, h(Root));
}

const container = document.getElementById('app');
if (container) render(h(App), container);
