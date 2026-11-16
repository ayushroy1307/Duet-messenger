import { h, useMemo, useState } from '../preact.js';
import { Avatar, Banner, Button, EmptyState, IconButton, LinkButton, Spinner } from '../ui.js';
import { Icon, LogoMark } from '../icons.js';
import {
  acceptConnection,
  declineConnection,
  errorMessage,
  lockVault,
  openConversation,
  openSheet,
  publishKeysNow,
  state,
  toast,
  useApp
} from '../store.js';
import { formatRelative, truncate } from '../util.js';

export function HomeScreen() {
  const app = useApp();
  const [query, setQuery] = useState('');
  const [requestBusy, setRequestBusy] = useState(null);

  const conversations = app.conversations;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter((conversation) => {
      const name = String(conversation.peer?.displayName || '').toLowerCase();
      const preview = (app.previews[conversation.id]?.text || '').toLowerCase();
      return name.includes(needle) || preview.includes(needle);
    });
  }, [conversations, query, app.previews]);

  const incoming = app.requests.incoming || [];
  const outgoing = app.requests.outgoing || [];
  const hasConversations = conversations.length > 0;

  const respond = async (request, action) => {
    setRequestBusy(request.id);
    try {
      if (action === 'accept') await acceptConnection(request.id);
      else await declineConnection(request.id);
    } catch (error) {
      toast(errorMessage(error), { tone: 'danger' });
    } finally {
      setRequestBusy(null);
    }
  };

  return h(
    'div',
    { class: 'screen' },
    h(
      'header',
      { class: 'topbar' },
      h(LogoMark, { size: 36 }),
      h(
        'div',
        { class: 'grow' },
        h('h1', { class: 'topbar-title' }, 'Duet'),
        h(
          'p',
          { class: 'topbar-sub' },
          app.offline
            ? 'Offline — cached view'
            : h('span', { class: 'row gap-4' }, h(Icon, { name: 'lock', size: 10 }), 'End-to-end encrypted')
        )
      ),
      h(
        'div',
        { class: 'topbar-actions' },
        app.canInstall
          ? h(IconButton, { name: 'download', label: 'Install Duet', onClick: () => import('../store.js').then(({ promptInstall }) => promptInstall()) })
          : null,
        h(IconButton, { name: 'lock', label: 'Lock vault', onClick: () => lockVault('manual') }),
        h(IconButton, { name: 'settings', label: 'Settings', onClick: () => openSheet('settings') }),
        h(IconButton, { name: 'plus', label: 'New conversation', tone: 'accent', onClick: () => openSheet('newChat') })
      )
    ),
    app.offline
      ? h(
          'div',
          { class: 'offline-bar', role: 'status' },
          h(Icon, { name: 'wifi-off', size: 15 }),
          h('span', null, 'You are offline. Cached previews stay available; sending resumes when you reconnect.')
        )
      : null,
    h(
      'div',
      { class: 'scroll-y' },
      h(
        'div',
        { class: 'home-body' },
        app.vault.keyError
          ? h(
              'div',
              { class: 'home-section' },
              h(
                Banner,
                {
                  tone: 'warn',
                  icon: 'key',
                  title: 'Encryption keys are not published',
                  actions: h(Button, { size: 'sm', variant: 'secondary', onClick: () => publishKeysNow().catch((error) => toast(errorMessage(error), { tone: 'danger' })) }, 'Retry')
                },
                truncate(app.vault.keyError, 160)
              )
            )
          : null,

        incoming.length
          ? h(
              'div',
              { class: 'home-section' },
              h('div', { class: 'section-label' }, h('span', null, 'Connection requests'), h('span', { class: 'faint' }, String(incoming.length))),
              h(
                'div',
                { class: 'requests' },
                incoming.map((request) => h(
                  'div',
                  { key: request.id, class: 'request-card' },
                  h(Avatar, { name: request.peer?.displayName || '?', color: request.peer?.avatarColor || 0, size: 'md' }),
                  h(
                    'div',
                    { class: 'grow' },
                    h('p', { class: 'req-name' }, request.peer?.displayName || 'Someone'),
                    h('p', { class: 'req-sub' }, 'wants to connect with you')
                  ),
                  h(
                    'div',
                    { class: 'request-actions' },
                    h(IconButton, {
                      name: 'x',
                      label: 'Decline',
                      class: 'sm',
                      disabled: requestBusy === request.id,
                      onClick: () => respond(request, 'decline')
                    }),
                    h(Button, {
                      size: 'sm',
                      loading: requestBusy === request.id,
                      onClick: () => respond(request, 'accept')
                    }, 'Accept')
                  )
                ))
              )
            )
          : null,

        outgoing.length
          ? h(
              'div',
              { class: 'home-section' },
              h('div', { class: 'section-label' }, h('span', null, 'Waiting')),
              h(
                'div',
                { class: 'requests' },
                outgoing.map((request) => h(
                  'div',
                  { key: request.id, class: 'request-card' },
                  h(Avatar, { name: request.peer?.displayName || '?', color: request.peer?.avatarColor || 0, size: 'md' }),
                  h(
                    'div',
                    { class: 'grow' },
                    h('p', { class: 'req-name' }, request.peer?.displayName || 'Someone'),
                    h('p', { class: 'req-sub' }, 'will see your request when they open Duet')
                  ),
                  h(Icon, { name: 'clock', size: 17, class: 'faint' })
                ))
              )
            )
          : null,

        hasConversations
          ? h(
              'div',
              { class: 'search-wrap' },
              h(Icon, { name: 'search', size: 17 }),
              h('input', {
                class: 'search-input',
                type: 'search',
                placeholder: 'Search conversations',
                value: query,
                'aria-label': 'Search conversations',
                onInput: (event) => setQuery(event.target.value)
              })
            )
          : null,

        !hasConversations
          ? h(
              'div',
              { class: 'home-section' },
              h(
                'div',
                { class: 'invite-card' },
                h('span', { class: 'feature-icon' }, h(Icon, { name: 'link', size: 19 })),
                h(
                  'div',
                  { class: 'grow' },
                  h('p', { class: 'invite-title' }, 'Invite someone you trust'),
                  h('p', { class: 'invite-sub' }, 'A single-use link creates your two-person conversation without sharing a phone number.')
                ),
                h(Button, { size: 'sm', onClick: () => openSheet('invite') }, 'Invite')
              ),
              h(
                EmptyState,
                {
                  icon: 'message',
                  title: 'A quiet room for two',
                  action: h(
                    'div',
                    { class: 'stack-10', style: { width: '200px' } },
                    h(Button, { block: true, icon: 'plus', onClick: () => openSheet('newChat') }, 'Start a chat'),
                    h(Button, { block: true, variant: 'secondary', icon: 'link', onClick: () => openSheet('invite') }, 'Create an invite')
                  )
                },
                'Invite someone, or start a conversation with a username you already know. You can only ever have one peer here.'
              )
            )
          : h(
              'div',
              { class: 'home-section' },
              h(
                'div',
                { class: 'section-label' },
                h('span', null, `Chats · ${conversations.length}`),
                h(LinkButton, { onClick: () => openSheet('invite') }, 'Invite someone')
              ),
              filtered.length
                ? h(
                    'div',
                    { class: 'conv-list' },
                    filtered.map((conversation) => h(ConversationRow, {
                      key: conversation.id,
                      conversation,
                      preview: app.previews[conversation.id],
                      hidePreviews: app.settings.hidePreviews,
                      onOpen: () => openConversation(conversation)
                    }))
                  )
                : h(
                    EmptyState,
                    { icon: 'search', title: 'No matches', art: false },
                    `Nothing matches “${query.trim()}”.`
                  )
            ),

        app.vault.backupError
          ? h(
              'div',
              { class: 'home-section' },
              h(Banner, { tone: 'warn', icon: 'alert', title: 'Key backup pending' }, 'Keep your recovery key safe. Duet will retry the encrypted backup when the connection allows.')
            )
          : null,

        h(
          'p',
          { class: 'settings-foot mt-12' },
          h(Icon, { name: 'shield-check', size: 12 }),
          ' Messages are encrypted on this device. The server sees only ciphertext and metadata.'
        )
      )
    )
  );
}

function ConversationRow({ conversation, preview, hidePreviews, onOpen }) {
  const peer = conversation.peer || {};
  const derived = preview || fallbackPreview(conversation, hidePreviews);
  const unread = Number(conversation.unreadCount || 0);
  const kind = derived.kind || 'unknown';
  const previewIcon = {
    secure: 'shield-check',
    media: 'image',
    hidden: 'bell-off',
    deleted: 'trash',
    session: 'lock'
  }[kind];

  return h(
    'button',
    { type: 'button', class: 'conv', onClick: onOpen },
    h(Avatar, {
      name: peer.displayName || '?',
      color: peer.avatarColor || 0,
      size: 'md',
      online: Boolean(peer.online)
    }),
    h(
      'div',
      { class: 'conv-main' },
      h(
        'div',
        { class: 'conv-line' },
        h('span', { class: 'conv-name' }, peer.displayName || 'Your contact'),
        h('span', { class: 'conv-time' }, formatRelative(conversation.lastMessageAt))
      ),
      h(
        'div',
        { class: `conv-preview${kind === 'secure' ? ' secure' : ''}${kind === 'unknown' || kind === 'deleted' ? ' damaged' : ''}` },
        previewIcon ? h(Icon, { name: previewIcon, size: 13 }) : null,
        h('span', { class: 'preview-text' }, derived.text)
      )
    ),
    h(
      'div',
      { class: 'conv-meta' },
      unread > 0 ? h('span', { class: 'badge', 'aria-label': `${unread} unread` }, unread > 99 ? '99+' : unread) : null
    )
  );
}

function fallbackPreview(conversation, hidePreviews) {
  if (!conversation.lastMessageAt) return { text: 'Say hello', kind: 'unknown' };
  if (conversation.lastMessageType === 'session') return { text: 'Secure session', kind: 'secure' };
  if (hidePreviews) return { text: 'New message', kind: 'hidden' };
  return { text: 'Encrypted message', kind: 'unknown' };
}
