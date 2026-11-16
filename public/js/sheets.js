import { h, useEffect, useRef, useState } from './preact.js';
import { Avatar, Banner, Button, Field, IconButton, LinkButton, Sheet, Spinner, useCopy } from './ui.js';
import { Icon, LogoMark } from './icons.js';
import { loadMediaBytes, useMediaSource } from './media.js';
import {
  ChangePinSheet,
  SettingsSheet,
  closeSheetWithReturn
} from './settings.js';
import {
  closeMediaViewer,
  closeSheet,
  createInvite,
  deleteMessage,
  errorMessage,
  mutate,
  openMediaViewer,
  openSheet,
  regenerateRecovery,
  removeDeviceKeys,
  saveEdit,
  setPhase,
  signOut,
  signOutAll,
  startChat,
  state,
  toast,
  updateProfile,
  useApp
} from './store.js';
import {
  copyText,
  downloadBlob,
  downloadText,
  formatRelative,
  humanSize,
  safeFileName,
  truncate
} from './util.js';
import { recoveryGroups } from './crypto.js';

const AVATAR_COLORS = [0, 1, 2, 3, 4, 5, 6, 7];

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

export function SheetHost() {
  const app = useApp();
  const name = app.sheets?.name;
  if (!name) return null;
  switch (name) {
    case 'settings': return h(SettingsSheet);
    case 'changePin': return h(ChangePinSheet);
    case 'editProfile': return h(EditProfileSheet);
    case 'about': return h(AboutSheet);
    case 'newChat': return h(NewChatSheet);
    case 'invite': return h(InviteSheet);
    case 'conversationMenu': return h(ConversationMenuSheet);
    case 'message': return h(MessageActionsSheet);
    case 'restoreConfirm': return h(RestoreConfirmSheet);
    case 'regenerateRecoveryConfirm': return h(RegenerateRecoveryConfirm);
    case 'recoveryKey': return h(RecoveryKeySheet);
    case 'signOutConfirm': return h(SignOutConfirmSheet);
    case 'signOutAllConfirm': return h(SignOutAllConfirmSheet);
    case 'removeKeysConfirm': return h(RemoveKeysConfirmSheet);
    default: return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Edit profile                                                               */
/* -------------------------------------------------------------------------- */

function EditProfileSheet() {
  const app = useApp();
  const initial = app.auth.user || {};
  const returnTo = state.sheets.returnTo || null;
  const [name, setName] = useState(initial.displayName || '');
  const [color, setColor] = useState(Number(initial.avatarColor || 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const trimmed = name.trim();

  const submit = async (event) => {
    event.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateProfile(trimmed, color, { returnTo });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return h(
    Sheet,
    {
      title: 'Your profile',
      subtitle: 'This is what your contact sees. Your username stays private.',
      onClose: closeSheetWithReturn,
      wide: true,
      footer: h(Button, { type: 'submit', form: 'edit-profile-form', loading: busy, disabled: !trimmed }, 'Save')
    },
    h(
      'form',
      { id: 'edit-profile-form', class: 'stack-20', onSubmit: submit },
      h(
        'div',
        { class: 'avatar-picker' },
        h(Avatar, { name: trimmed || '?', color, size: 'xl' }),
        h(
          'div',
          { class: 'grow' },
          h('p', { class: 'strong' }, trimmed || 'Your name'),
          h('p', { class: 'small faint mt-4' }, initial.username ? `@${initial.username}` : 'Signed in to Duet')
        )
      ),
      h(
        Field,
        { label: 'Display name', htmlFor: 'edit-display-name' },
        h('input', {
          id: 'edit-display-name',
          class: 'input',
          value: name,
          maxlength: '40',
          autocomplete: 'nickname',
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
          AVATAR_COLORS.map((value) => h('button', {
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
      error ? h('p', { class: 'error-text', role: 'alert' }, error) : null
    )
  );
}

/* -------------------------------------------------------------------------- */
/* New chat                                                                   */
/* -------------------------------------------------------------------------- */

function NewChatSheet() {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);

  useEffect(() => { input.current?.focus(); }, []);

  const normalized = username.toLowerCase().trim();
  const valid = /^[a-z0-9_.-]{3,32}$/.test(normalized);

  const submit = async (event) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await startChat(normalized);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return h(
    Sheet,
    {
      title: 'Start a conversation',
      subtitle: 'Look up someone by their Duet username.',
      onClose: closeSheet,
      footer: h(Button, { type: 'submit', form: 'new-chat-form', loading: busy, disabled: !valid }, 'Send request')
    },
    h(
      'form',
      { id: 'new-chat-form', class: 'stack-16', onSubmit: submit },
      h(
        Field,
        {
          label: 'Username',
          htmlFor: 'connect-username',
          hint: '3–32 characters: letters, numbers, underscore, dash or dot.'
        },
        h('input', {
          id: 'connect-username',
          ref: input,
          class: 'input',
          type: 'text',
          inputmode: 'text',
          autocomplete: 'username',
          autocapitalize: 'none',
          spellcheck: 'false',
          placeholder: 'theirusername',
          value: username,
          maxlength: '32',
          onInput: (event) => setUsername(event.target.value)
        })
      ),
      error ? h('p', { class: 'error-text', role: 'alert' }, error) : null,
      h(Banner, { tone: 'info', icon: 'shield-check' }, 'The other person must accept before a conversation is created. Usernames are matched exactly and are not a public directory.'),
      h(
        'p',
        { class: 'hint center' },
        'Prefer a one-time link? ',
        h(LinkButton, { onClick: () => openSheet('invite') }, 'Create an invite instead')
      )
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Invite                                                                     */
/* -------------------------------------------------------------------------- */

const INVITE_EXPIRY = [
  { value: 24, label: '24 hours' },
  { value: 72, label: '3 days' },
  { value: 168, label: '7 days' }
];

function InviteSheet() {
  const [hours, setHours] = useState(72);
  const [invite, setInvite] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const [copied, copy] = useCopy();

  const generate = async (expiry = hours) => {
    setBusy(true);
    setError(null);
    try {
      const created = await createInvite(expiry);
      setInvite(created);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void generate(72); }, []);

  const share = async () => {
    if (!invite?.url) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join me on Duet',
          text: 'A private, end-to-end encrypted conversation for two.',
          url: invite.url
        });
        return;
      } catch { /* user cancelled */ }
    }
    const done = await copy(invite.url);
    if (done) toast('Invite link copied.', { tone: 'ok' });
  };

  return h(
    Sheet,
    {
      title: 'Invite someone',
      subtitle: 'A one-time link that creates your two-person conversation.',
      onClose: closeSheet,
      footer: h(
        'div',
        { class: 'share-row' },
        h(Button, { variant: 'secondary', icon: 'download', onClick: () => generate(hours), disabled: busy }, 'New link'),
        h(Button, { icon: 'share', onClick: share, disabled: !invite?.url }, 'Share')
      )
    },
    h(
      'div',
      { class: 'stack-20' },
      h(
        'div',
        { class: 'invite-hero' },
        h('span', { class: 'icon-wrap' }, h(Icon, { name: 'link', size: 26 })),
        h('h2', { class: 'h2' }, 'One link, one person'),
        h('p', { class: 'small muted mt-8' }, 'Your contact opens this link, signs in, and lands directly in your conversation. Neither of you needs to share a phone number.')
      ),
      busy
        ? h('div', { class: 'center' }, h(Spinner, { size: 'lg', label: 'Creating invite' }))
        : invite
          ? h(
              'div',
              { class: 'stack-10' },
              h(
                'div',
                { class: 'invite-link' },
                h('code', null, invite.url),
                h(IconButton, {
                  name: copied ? 'check' : 'copy',
                  label: copied ? 'Copied' : 'Copy invite link',
                  class: 'sm',
                  onClick: () => copy(invite.url)
                })
              ),
              h(
                'p',
                { class: 'hint' },
                `Single use · expires ${formatRelative(invite.expiresAt)}. Anyone with the link can join if it is unused.`
              )
            )
          : null,
      error
        ? h(Banner, { tone: 'danger', icon: 'alert', title: 'Could not create an invite' }, error)
        : null,
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'label', for: 'invite-expiry' }, 'Link lifetime'),
        h(
          'select',
          {
            id: 'invite-expiry',
            class: 'select',
            value: String(hours),
            disabled: busy,
            onChange: (event) => {
              const next = Number(event.target.value);
              setHours(next);
              void generate(next);
            }
          },
          INVITE_EXPIRY.map((option) => h('option', { key: option.value, value: String(option.value) }, option.label))
        )
      ),
      h(Banner, { tone: 'info', icon: 'info' }, 'Invite links are anonymous. They never contain your username or your display name, and they stop working once accepted.')
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Conversation menu                                                          */
/* -------------------------------------------------------------------------- */

function ConversationMenuSheet() {
  const app = useApp();
  const active = app.active;
  const peer = active.peer || {};
  const session = active.session || {};

  return h(
    Sheet,
    {
      title: 'Conversation',
      onClose: closeSheet
    },
    h(
      'div',
      { class: 'stack-16' },
      h(
        'div',
        { class: 'profile-card' },
        h(Avatar, { name: peer.displayName || '?', color: peer.avatarColor || 0, size: 'lg', online: Boolean(peer.online) }),
        h(
          'div',
          { class: 'grow' },
          h('p', { class: 'profile-name' }, peer.displayName || 'Your contact'),
          h(
            'p',
            { class: 'profile-sub' },
            peer.presenceVisible === false
              ? 'Presence hidden'
              : peer.online ? 'Online' : (peer.lastSeenAt ? `Last seen ${formatRelative(peer.lastSeenAt)}` : 'Offline')
          )
        )
      ),
      h(
        'div',
        { class: 'set-card' },
        h(
          'div',
          { class: 'set-row' },
          h('span', { class: 'set-icon' }, h(Icon, { name: 'lock', size: 17 })),
          h(
            'div',
            { class: 'set-row-main' },
            h('p', { class: 'set-row-title' }, 'End-to-end encrypted'),
            h(
              'p',
              { class: 'set-row-sub' },
              session.exists
                ? `Double Ratchet session${session.generation ? ` · generation ${String(session.generation).slice(0, 8)}` : ''}`
                : 'Waiting for both devices to exchange keys'
            )
          ),
          session.exists
            ? h('span', { class: 'chip ok' }, 'Secure')
            : h('span', { class: 'chip warn' }, 'Pending')
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'set-row',
            onClick: () => { closeSheet(); setPhase('home'); }
          },
          h('span', { class: 'set-icon' }, h(Icon, { name: 'message', size: 17 })),
          h(
            'div',
            { class: 'set-row-main' },
            h('p', { class: 'set-row-title' }, 'Back to conversations'),
            h('p', { class: 'set-row-sub' }, 'The conversation stays in your list.')
          ),
          h(Icon, { name: 'chevron-right', size: 18, class: 'faint' })
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'set-row',
            onClick: () => { closeSheet(); import('./store.js').then(({ lockVault }) => lockVault('manual')); }
          },
          h('span', { class: 'set-icon' }, h(Icon, { name: 'lock', size: 17 })),
          h(
            'div',
            { class: 'set-row-main' },
            h('p', { class: 'set-row-title' }, 'Lock Duet now'),
            h('p', { class: 'set-row-sub' }, 'Clears keys and decrypted copies from memory.')
          ),
          h(Icon, { name: 'chevron-right', size: 18, class: 'faint' })
        )
      ),
      h(Banner, { tone: 'info', icon: 'shield-check' }, 'The server relays ciphertext and public keys. It never sees message text, attachments, file names or your vault PIN.')
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Message actions                                                            */
/* -------------------------------------------------------------------------- */

function MessageActionsSheet() {
  const app = useApp();
  const messageId = app.sheets.messageId;
  const item = app.active.messages.find((entry) => entry.row.id === messageId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item?.payload?.kind === 'text' ? item.payload.text : '');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);

  if (!item) {
    return h(
      Sheet,
      { title: 'Message', onClose: closeSheet },
      h('p', { class: 'muted' }, 'This message is no longer in the open conversation.'),
      h(Button, { class: 'mt-20', block: true, variant: 'secondary', onClick: closeSheet }, 'Close')
    );
  }

  const mine = item.row.senderId === app.auth.user?.id;
  const payload = item.payload;
  const isText = payload?.kind === 'text';
  const isMedia = payload?.kind === 'media';
  const deleted = item.status === 'deleted' || Boolean(item.row.deletedAt);
  const damaged = item.status === 'damaged';

  const reply = () => {
    closeSheet();
    window.dispatchEvent(new CustomEvent('duet:reply', { detail: item }));
  };

  const copy = async () => {
    if (!isText) return;
    await copyText(payload.text || '');
    toast('Message copied.', { tone: 'ok' });
    closeSheet();
  };

  const save = async (event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveEdit(item.row.id, text);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (app.settings.confirmDelete && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteMessage(item.row.id);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const open = () => {
    closeSheet();
    openMediaViewer({ payload, name: payload.name || 'Attachment' });
  };

  const download = async () => {
    setBusy(true);
    try {
      const { bytes, mime } = await loadMediaBytes(payload);
      downloadBlob(new Blob([bytes], { type: mime }), safeFileName(payload.name || 'duet-attachment'));
    } catch (failure) {
      toast(errorMessage(failure), { tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return h(
      Sheet,
      {
        title: 'Edit message',
        subtitle: 'The edit is encrypted and stored as new server-side state.',
        onClose: () => setEditing(false),
        wide: true,
        footer: h(
          'div',
          { class: 'share-row' },
          h(Button, { variant: 'secondary', onClick: () => setEditing(false) }, 'Cancel'),
          h(Button, { type: 'submit', form: 'edit-message-form', loading: busy, disabled: !draft.trim() }, 'Save edit')
        )
      },
      h(
        'form',
        { id: 'edit-message-form', class: 'stack-16', onSubmit: save },
        h(
          Field,
          { label: 'Message', htmlFor: 'edit-message-text' },
          h('textarea', {
            id: 'edit-message-text',
            class: 'textarea',
            value: draft,
            maxlength: '6000',
            rows: 5,
            onInput: (event) => setDraft(event.target.value)
          })
        ),
        error ? h('p', { class: 'error-text', role: 'alert' }, error) : null
      )
    );
  }

  return h(
    Sheet,
    {
      title: 'Message actions',
      subtitle: deleted ? 'Deleted message' : damaged ? 'Unreadable on this device' : isMedia ? (payload.name || 'Attachment') : truncate(payload?.text || '', 70),
      onClose: closeSheet
    },
    h(
      'div',
      { class: 'menu-list' },
      !deleted && !damaged && isText
        ? h(MenuButton, { icon: 'reply', label: 'Reply', onClick: reply })
        : null,
      !deleted && !damaged && isText
        ? h(MenuButton, { icon: 'copy', label: 'Copy text', onClick: copy })
        : null,
      !deleted && !damaged && isMedia
        ? h(MenuButton, { icon: 'image', label: 'Open attachment', onClick: open })
        : null,
      !deleted && !damaged && isMedia
        ? h(MenuButton, {
            icon: 'download',
            label: 'Save attachment',
            sub: humanSize(payload.size || 0),
            onClick: download,
            disabled: busy
          })
        : null,
      mine && !deleted && !damaged && isText
        ? h(MenuButton, { icon: 'edit', label: 'Edit message', onClick: () => setEditing(true) })
        : null,
      mine && !deleted
        ? h(MenuButton, {
            icon: 'trash',
            label: confirming ? 'Tap again to delete for both sides' : 'Delete message',
            sub: 'Removes the message from both devices.',
            danger: true,
            onClick: remove,
            disabled: busy
          })
        : null,
      deleted && mine
        ? h('p', { class: 'hint center pad' }, 'This message was already deleted.')
        : null,
      error ? h('p', { class: 'error-text pad', role: 'alert' }, error) : null
    )
  );
}

function MenuButton({ icon, label, sub, onClick, danger = false, disabled = false }) {
  return h(
    'button',
    {
      type: 'button',
      class: `menu-item${danger ? ' danger' : ''}`,
      onClick,
      disabled
    },
    h('span', { class: 'menu-icon' }, h(Icon, { name: icon, size: 18 })),
    h(
      'span',
      { class: 'grow' },
      h('span', { class: 'row gap-6' }, label),
      sub ? h('span', { class: 'menu-sub' }, sub) : null
    ),
    disabled ? null : h(Icon, { name: 'chevron-right', size: 17, class: 'faint' })
  );
}

/* -------------------------------------------------------------------------- */
/* About                                                                      */
/* -------------------------------------------------------------------------- */

function AboutSheet() {
  const app = useApp();
  return h(
    Sheet,
    {
      title: 'How Duet protects you',
      onClose: closeSheetWithReturn,
      wide: true
    },
    h(
      'div',
      null,
      h(
        'div',
        { class: 'about-hero' },
        h(LogoMark, { size: 54 }),
        h('h2', { class: 'h2' }, 'A conversation for two'),
        h('p', { class: 'small muted mt-8' }, 'No group chats, no directory, no advertising. Duet is built around one person talking to one person.')
      ),
      h(
        'div',
        { class: 'about-section' },
        h('h3', null, 'End-to-end encryption'),
        h('p', null, 'Messages use X3DH for session setup and a Double Ratchet for every message after that, with XChaCha20-Poly1305 for authenticated encryption. Keys are generated on your device and never sent to the server in readable form.')
      ),
      h(
        'div',
        { class: 'about-section' },
        h('h3', null, 'What the server can see'),
        h('p', null, 'Ciphertext, public keys, conversation membership, timestamps and delivery state. It cannot see message text, photo or video content, file names, or your vault PIN and recovery key.')
      ),
      h(
        'div',
        { class: 'about-section' },
        h('h3', null, 'Your vault'),
        h('p', null, 'A random 32-byte master key is generated on first run and sealed with your PIN or passphrase using scrypt, or with a passkey through the WebAuthn PRF extension. A recovery key can open an encrypted backup if you lose the device.')
      ),
      h(
        'div',
        { class: 'about-section' },
        h('h3', null, 'If a key is lost'),
        h('p', null, 'Duet cannot recover messages without your original keys. Messages that arrive while a session is broken show a damage notice rather than a silent blank, and the app explains how to repair the session.')
      ),
      h(
        'div',
        { class: 'about-section' },
        h('h3', null, 'Build'),
        h('p', { class: 'mono small' }, app.build || 'client'),
        h('p', { class: 'small mt-4' }, 'Protocol 1 · SSE realtime · opaque Web Push'),
        h(
          'div',
          { class: 'mt-12' },
          h(LinkButton, { onClick: () => { closeSheet(); window.location.assign('/tests.html'); } }, 'Open the crypto property tests')
        )
      ),
      h(Banner, { tone: 'info', icon: 'info' }, 'Duet is a two-party messenger. If you need a group, this app is deliberately the wrong shape.')
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Recovery key                                                               */
/* -------------------------------------------------------------------------- */

function RegenerateRecoveryConfirm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await regenerateRecovery(state.sheets.returnTo || null);
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return h(
    Sheet,
    {
      title: 'Replace your recovery key?',
      onClose: closeSheetWithReturn,
      footer: h(
        'div',
        { class: 'share-row' },
        h(Button, { variant: 'secondary', onClick: closeSheetWithReturn }, 'Cancel'),
        h(Button, { variant: 'danger', loading: busy, onClick: confirm }, 'Replace key')
      )
    },
    h(
      'div',
      { class: 'stack-16' },
      h(Banner, { tone: 'warn', icon: 'alert', title: 'The old key stops working immediately' }, 'Any printed or saved copy of the previous recovery key will no longer open your encrypted backup. Make sure you can save the new one now.'),
      h('p', { class: 'small muted' }, 'Your messages and existing sessions are not affected. Only the wrapped backup of your keys changes.'),
      error ? h('p', { class: 'error-text', role: 'alert' }, error) : null
    )
  );
}

function RecoveryKeySheet() {
  const app = useApp();
  const [copied, copy] = useCopy();
  const secret = app.recovery.secret;
  const pretty = recoveryGroups(secret || '');
  const returnTo = state.sheets.returnTo || null;

  const done = () => {
    mutate((current) => { current.recovery = { ...current.recovery, secret: null }; });
    if (returnTo) openSheet(returnTo);
    else closeSheet();
  };

  const download = () => {
    const text = [
      'Duet recovery key',
      '=================',
      '',
      pretty,
      '',
      `Account: ${app.auth.user?.username ? `@${app.auth.user.username}` : 'your Duet account'}`,
      `Created: ${new Date().toISOString()}`,
      '',
      'This key is the only way to restore your encrypted keys on another device.',
      'Keep it offline. Anyone with this key can open a backup of your keys.',
      'Duet support cannot recover it for you.'
    ].join('\n');
    downloadText(text, 'duet-recovery-key.txt');
  };

  return h(
    Sheet,
    {
      title: 'Your new recovery key',
      onClose: done,
      wide: true,
      footer: h(Button, { block: true, onClick: done }, 'I saved this key')
    },
    secret
      ? h(
          'div',
          { class: 'stack-16' },
          h(Banner, { tone: 'warn', icon: 'key', title: 'Shown once' }, 'This is the only time Duet will display this key. Save it offline before you close this screen.'),
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
          h(ErrorState, { error: app.recovery.backupError })
        )
      : h(
          'div',
          { class: 'stack-16' },
          h(Banner, { tone: 'info', icon: 'info', title: 'No key to show' }, 'For security, a recovery key is displayed once. Replace it again from Settings if you did not save it.')
        )
  );
}

/* -------------------------------------------------------------------------- */
/* Restore confirmation                                                       */
/* -------------------------------------------------------------------------- */

function RestoreConfirmSheet() {
  return h(
    Sheet,
    {
      title: 'Restore with a recovery key',
      onClose: closeSheet,
      footer: h(
        'div',
        { class: 'share-row' },
        h(Button, { variant: 'secondary', onClick: closeSheet }, 'Cancel'),
        h(Button, {
          onClick: () => {
            closeSheet();
            setPhase('vault-restore');
          }
        }, 'Enter recovery key')
      )
    },
    h(
      'div',
      { class: 'stack-16' },
      h(Banner, { tone: 'warn', icon: 'alert', title: 'This replaces the local vault' }, 'Your current device keys will be replaced by the encrypted backup from this account. Only continue if you have the recovery key.'),
      h('p', { class: 'small muted' }, 'This does not delete messages on the server. It restores the keys needed to read them on this device.')
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Session / sign out confirmations                                           */
/* -------------------------------------------------------------------------- */

function SignOutConfirmSheet() {
  const [busy, setBusy] = useState(false);
  return h(
    Sheet,
    {
      title: 'Sign out?',
      onClose: closeSheetWithReturn,
      footer: h(
        'div',
        { class: 'share-row' },
        h(Button, { variant: 'secondary', onClick: closeSheetWithReturn }, 'Cancel'),
        h(Button, {
          variant: 'danger',
          loading: busy,
          onClick: async () => {
            setBusy(true);
            closeSheet();
            await signOut();
          }
        }, 'Sign out')
      )
    },
    h(
      'div',
      { class: 'stack-16' },
      h('p', { class: 'small muted' }, 'You are signed out of this browser. Your encrypted keys stay on this device and the vault returns to the lock screen the next time you sign in.'),
      h(Banner, { tone: 'info', icon: 'key' }, 'To use Duet on another device, sign in with the same username and restore with your recovery key.')
    )
  );
}

function SignOutAllConfirmSheet() {
  const [busy, setBusy] = useState(false);
  return h(
    Sheet,
    {
      title: 'Sign out everywhere?',
      onClose: closeSheetWithReturn,
      footer: h(
        'div',
        { class: 'share-row' },
        h(Button, { variant: 'secondary', onClick: closeSheetWithReturn }, 'Cancel'),
        h(Button, {
          variant: 'danger',
          loading: busy,
          onClick: async () => {
            setBusy(true);
            closeSheet();
            await signOutAll();
          }
        }, 'Sign out all devices')
      )
    },
    h(
      'div',
      { class: 'stack-16' },
      h(Banner, { tone: 'warn', icon: 'alert', title: 'Every session is revoked' }, 'This device and every other signed-in browser will need to sign in again. Local vaults are not deleted.'),
      h('p', { class: 'small muted' }, 'Use this if you think someone else has access to your account.')
    )
  );
}

function RemoveKeysConfirmSheet() {
  const [busy, setBusy] = useState(false);
  return h(
    Sheet,
    {
      title: 'Remove keys from this device?',
      onClose: closeSheetWithReturn,
      footer: h(
        'div',
        { class: 'share-row' },
        h(Button, { variant: 'secondary', onClick: closeSheetWithReturn }, 'Cancel'),
        h(Button, {
          variant: 'danger',
          loading: busy,
          onClick: async () => {
            setBusy(true);
            closeSheet();
            try {
              await removeDeviceKeys();
            } catch (error) {
              toast(errorMessage(error), { tone: 'danger' });
            }
          }
        }, 'Remove keys')
      )
    },
    h(
      'div',
      { class: 'stack-16' },
      h(Banner, { tone: 'danger', icon: 'alert', title: 'This cannot be undone without your recovery key' }, 'The local vault, cached plaintext and media copies on this device are destroyed. Messages on the server remain encrypted with your old keys.'),
      h('p', { class: 'small muted' }, 'You will be signed out. To return, sign in with your username and enter your recovery key.')
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Media viewer                                                               */
/* -------------------------------------------------------------------------- */

export function MediaViewer() {
  const app = useApp();
  const view = app.mediaViewer;
  const media = useMediaSource(view?.payload);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!view) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') closeMediaViewer();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view]);

  if (!view) return null;
  const isVideo = String(view.payload?.mime || '').startsWith('video/');
  const name = view.name || (isVideo ? 'Video' : 'Photo');

  const save = async () => {
    if (!media.bytes) return;
    setSaving(true);
    try {
      downloadBlob(new Blob([media.bytes], { type: media.mime || view.payload.mime }), safeFileName(name, 'duet-media'));
    } finally {
      setSaving(false);
    }
  };

  return h(
    'div',
    {
      class: 'media-viewer',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': name,
      onClick: (event) => {
        if (event.target === event.currentTarget) closeMediaViewer();
      }
    },
    h(
      'div',
      { class: 'media-viewer-head' },
      h(IconButton, { name: 'x', label: 'Close viewer', onClick: closeMediaViewer }),
      h(
        'div',
        { class: 'viewer-title' },
        h('p', { class: 'viewer-name' }, name),
        h('p', { class: 'viewer-sub' }, media.status === 'ready' ? 'Decrypted on this device' : 'Opening…')
      ),
      h(IconButton, {
        name: 'download',
        label: 'Save attachment',
        disabled: !media.bytes || saving,
        onClick: save
      })
    ),
    h(
      'div',
      { class: 'media-viewer-body' },
      media.status === 'loading'
        ? h('div', { class: 'viewer-state' }, h(Spinner, { size: 'lg' }), h('span', null, 'Decrypting attachment…'))
        : media.status === 'error'
          ? h(
              'div',
              { class: 'viewer-state' },
              h(Icon, { name: 'lock', size: 28 }),
              h('span', null, media.error || 'This attachment could not be opened.'),
              h(Button, { size: 'sm', variant: 'secondary', onClick: media.retry }, 'Try again')
            )
          : isVideo
            ? h('video', { src: media.url, controls: true, playsinline: true, autoplay: true })
            : h('img', { src: media.url, alt: name })
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function ErrorState({ error }) {
  if (!error) return null;
  return h(Banner, { tone: 'warn', icon: 'alert', title: 'Encrypted backup pending' }, String(error));
}
