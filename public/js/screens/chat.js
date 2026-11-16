import { h, useEffect, useMemo, useRef, useState } from '../preact.js';
import { Avatar, Banner, Button, EmptyState, IconButton, Skeleton, Spinner, cx } from '../ui.js';
import { Icon } from '../icons.js';
import { useMediaSource } from '../media.js';
import {
  closeChat,
  errorMessage,
  getVault,
  loadOlder,
  markConversationRead,
  mutate,
  openMediaViewer,
  openSheet,
  requestSecureSession,
  retryDamaged,
  retryMessage,
  sendMedia,
  sendText,
  toast,
  useApp
} from '../store.js';
import { formatDay, formatLastSeen, formatTime, humanSize, truncate } from '../util.js';

const EMOJIS = [
  '😀', '😄', '😊', '🙂', '😉', '😍', '🥰', '😘',
  '😌', '😔', '😢', '😭', '😅', '😂', '🤭', '🤔',
  '😐', '🙃', '😴', '🤗', '😮', '😯', '😬', '🙄',
  '👍', '👎', '👏', '🙌', '🤝', '🙏', '💪', '✌️',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🤍', '💔',
  '🔥', '✨', '🎉', '🌙', '☀️', '🌿', '🌸', '🍀',
  '☕', '🍕', '🎵', '📷', '💬', '🔒', '👀', '✅'
];

export function ChatScreen() {
  const app = useApp();
  const active = app.active;
  const peer = active.peer || {};
  const selfId = app.auth.user?.id;
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [sending, setSending] = useState(false);
  const body = useRef(null);
  const input = useRef(null);
  const fileInput = useRef(null);
  const lastCount = useRef(0);
  const loadingOlder = useRef(false);

  const messages = active.messages;
  const lastMessage = messages[messages.length - 1];

  useEffect(() => {
    setDraft('');
    setReply(null);
    setEmojiOpen(false);
    setAtBottom(true);
    lastCount.current = 0;
    requestAnimationFrame(() => {
      const node = body.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
    if (window.innerWidth > 760) input.current?.focus();
  }, [active.id]);

  useEffect(() => {
    if (active.id && !active.loading) {
      const node = body.current;
      if (node && (atBottom || lastCount.current === 0)) {
        node.scrollTop = node.scrollHeight;
      }
    }
    lastCount.current = messages.length;
  }, [messages.length, active.loading]);

  useEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
  }, [draft]);

  useEffect(() => {
    if (!emojiOpen) return undefined;
    const close = (event) => {
      if (event.target.closest?.('.emoji-pop') || event.target.closest?.('[data-emoji-toggle]')) return;
      setEmojiOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [emojiOpen]);

  const onScroll = async () => {
    const node = body.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 90;
    setAtBottom(nearBottom);
    if (node.scrollTop < 90 && active.hasMore && !loadingOlder.current && !active.loadingOlder) {
      loadingOlder.current = true;
      const previousHeight = node.scrollHeight;
      const previousTop = node.scrollTop;
      try {
        await loadOlder();
        requestAnimationFrame(() => {
          const next = body.current;
          if (next) next.scrollTop = next.scrollHeight - previousHeight + previousTop;
        });
      } finally {
        loadingOlder.current = false;
      }
    }
  };

  const jumpLatest = () => {
    const node = body.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    setAtBottom(true);
  };

  const submit = async (event) => {
    event?.preventDefault();
    if (sending) return;
    const text = draft.trim();
    if (!text) return;
    if (!active.session.exists && String(selfId) > String(peer.id)) {
      toast('Encryption is still being set up by your contact.', { tone: 'warn' });
      return;
    }
    setSending(true);
    try {
      await sendText(text, { replyTo: reply });
      setDraft('');
      setReply(null);
      setEmojiOpen(false);
      requestAnimationFrame(jumpLatest);
    } catch (error) {
      toast(errorMessage(error), { tone: 'danger' });
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    if (app.settings.enterToSend) {
      event.preventDefault();
      void submit();
    }
  };

  const attach = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      await sendMedia(file);
      requestAnimationFrame(jumpLatest);
    } catch (error) {
      toast(errorMessage(error), { tone: 'danger' });
    }
  };

  const insertEmoji = (emoji) => {
    const node = input.current;
    const at = node?.selectionStart ?? draft.length;
    const end = node?.selectionEnd ?? draft.length;
    setDraft(`${draft.slice(0, at)}${emoji}${draft.slice(end)}`);
    requestAnimationFrame(() => {
      node?.focus();
      const next = at + emoji.length;
      node?.setSelectionRange(next, next);
    });
  };

  const startReply = (item) => {
    const payload = item.payload;
    let preview = 'Message';
    if (payload?.kind === 'text') preview = truncate(payload.text || '', 140);
    else if (payload?.kind === 'media') preview = payload.mime?.startsWith('video/') ? 'Video' : 'Photo';
    else if (payload?.kind === 'session') preview = 'Secure session';
    setReply({
      id: item.row.id,
      preview,
      mine: item.row.senderId === selfId
    });
    input.current?.focus();
  };

  useEffect(() => {
    const handler = (event) => {
      if (event.detail?.row) startReply(event.detail);
    };
    window.addEventListener('duet:reply', handler);
    return () => window.removeEventListener('duet:reply', handler);
  });

  const groupedInfo = useMemo(() => {
    const groups = [];
    let previous = null;
    for (const item of messages) {
      const sameSender = previous && previous.row.senderId === item.row.senderId;
      const prevTime = previous ? Date.parse(previous.row.createdAt) : 0;
      const thisTime = Date.parse(item.row.createdAt);
      const close = Number.isFinite(prevTime) && Number.isFinite(thisTime) && thisTime - prevTime < 4 * 60_000;
      const sameDay = previous && dayKey(previous.row.createdAt) === dayKey(item.row.createdAt);
      groups.push({ item, grouped: Boolean(sameSender && close && sameDay), previous });
      previous = item;
    }
    return groups;
  }, [messages]);

  const rows = [];
  let lastDay = null;
  for (const entry of groupedInfo) {
    const day = dayKey(entry.item.row.createdAt);
    if (day !== lastDay) {
      rows.push(h('div', { key: `day-${day}-${entry.item.row.id}`, class: 'day-sep' }, h('span', null, formatDay(entry.item.row.createdAt))));
      lastDay = day;
    }
    rows.push(h(MessageRow, {
      key: entry.item.row.id,
      item: entry.item,
      grouped: entry.grouped,
      mine: entry.item.row.senderId === selfId,
      peer,
      onReply: startReply,
      onMenu: (target) => openSheet('message', { messageId: target.row.id })
    }));
  }

  const headerStatus = () => {
    if (!active.session.exists) return 'Encryption pending';
    if (active.session.pending) return 'Securing…';
    if (!peer.presenceVisible) return 'Private';
    if (peer.online) return 'online';
    return formatLastSeen(peer.lastSeenAt, false);
  };

  const responderWaiting = !active.session.exists && String(selfId) > String(peer.id);
  const canSend = draft.trim().length > 0 && !sending && !(responderWaiting && !active.session.pending);

  return h(
    'div',
    { class: 'screen chat' },
    h(
      'header',
      { class: 'chat-head' },
      h(IconButton, { name: 'arrow-left', label: 'Back to conversations', onClick: closeChat }),
      h(
        'button',
        { type: 'button', class: 'chat-peer', onClick: () => openSheet('conversationMenu') },
        h(Avatar, {
          name: peer.displayName || '?',
          color: peer.avatarColor || 0,
          size: 'sm',
          online: Boolean(peer.online)
        }),
        h(
          'div',
          { class: 'grow', style: { minWidth: 0 } },
          h('p', { class: 'chat-peer-name' }, peer.displayName || 'Your contact'),
          h(
            'p',
            { class: cx('chat-peer-sub', active.session.exists && !active.session.pending && 'secure') },
            active.session.exists && !active.session.pending
              ? h(Icon, { name: 'lock', size: 10 })
              : active.session.pending
                ? h(Spinner)
                : h(Icon, { name: 'alert', size: 10 }),
            h('span', null, headerStatus())
          )
        )
      ),
      h(IconButton, { name: 'more', label: 'Conversation options', onClick: () => openSheet('conversationMenu') })
    ),
    h(
      'div',
      { class: 'chat-scroll-wrap' },
      h(
        'div',
        {
          id: 'message-scroll',
          ref: body,
          class: 'chat-body',
          onScroll,
          onClick: (event) => {
            if (!event.target.closest?.('.bubble')) setEmojiOpen(false);
          }
        },
        h(SessionBanner, { app, onRetry: requestSecureSession }),
        active.loading && !messages.length
          ? h(MessageSkeletons)
          : null,
        !active.loading && !messages.length
          ? h(EmptyState, {
              icon: active.session.exists ? 'message' : 'lock',
              title: active.session.exists ? 'No messages yet' : 'Securing this conversation',
              action: active.session.exists
                ? h(Button, { size: 'sm', variant: 'soft', onClick: () => input.current?.focus() }, 'Say hello')
                : null
            }, active.session.exists
              ? 'The first message is encrypted on this device and carries the session handshake.'
              : 'Messages will unlock as soon as both devices have exchanged keys.')
          : null,
        rows,
        active.loadingOlder ? h('div', { class: 'center mt-12' }, h(Spinner)) : null,
        active.error
          ? h('div', { class: 'mt-12' }, h(Banner, { tone: 'danger', icon: 'alert', title: 'Could not load messages' }, active.error))
          : null,
        h('div', { style: { height: '6px' } })
      ),
      !atBottom && messages.length
        ? h('button', { type: 'button', class: 'jump-latest', 'aria-label': 'Jump to latest', onClick: jumpLatest }, h(Icon, { name: 'chevron-down', size: 20 }))
        : null
    ),
    h(
      'form',
      { class: 'composer', onSubmit: submit },
      reply ? h(
        'div',
        { class: 'reply-bar' },
        h('div', { class: 'reply-body' },
          h('p', { class: 'reply-name' }, reply.mine ? 'You' : (peer.displayName || 'Your contact')),
          h('p', { class: 'reply-text' }, reply.preview)
        ),
        h(IconButton, { name: 'x', label: 'Cancel reply', class: 'sm', onClick: () => setReply(null) })
      ) : null,
      active.uploading
        ? h(
            'div',
            { class: 'upload-bar', role: 'status' },
            h(Icon, { name: active.uploading.kind === 'video' ? 'video' : 'image', size: 17 }),
            h(
              'div',
              { class: 'upload-body' },
              h('p', { class: 'upload-name' }, `Encrypting ${active.uploading.name || 'attachment'}…`),
              h('div', { class: 'progress' }, h('span', { style: { width: `${active.uploading.progress || 0}%` } }))
            ),
            h('span', { class: 'tiny faint' }, `${active.uploading.progress || 0}%`)
          )
        : null,
      emojiOpen
        ? h(
            'div',
            { class: 'emoji-pop', role: 'dialog', 'aria-label': 'Emoji picker' },
            h('div', { class: 'emoji-grid' }, EMOJIS.map((emoji) => h('button', {
              key: emoji,
              type: 'button',
              class: 'emoji-cell',
              'aria-label': emoji,
              onClick: () => insertEmoji(emoji)
            }, emoji)))
          )
        : null,
      h(
        'div',
        { class: 'composer-row' },
        h('input', {
          ref: fileInput,
          type: 'file',
          accept: 'image/*,video/*',
          class: 'sr-only',
          tabindex: '-1',
          'aria-hidden': 'true',
          onChange: attach
        }),
        h(IconButton, {
          name: 'paperclip',
          label: 'Attach a photo or video',
          onClick: () => fileInput.current?.click()
        }),
        h(
          'div',
          { class: 'composer-input-wrap' },
          h('textarea', {
            ref: input,
            class: 'composer-input',
            rows: 1,
            value: draft,
            placeholder: responderWaiting
              ? `Waiting for ${peer.displayName || 'your contact'} to finish encryption…`
              : 'Message',
            maxlength: 6000,
            'aria-label': 'Message',
            enterkeyhint: app.settings.enterToSend ? 'send' : 'enter',
            onInput: (event) => setDraft(event.target.value),
            onKeyDown
          }),
          h('button', {
            type: 'button',
            class: 'icon-btn sm',
            'data-emoji-toggle': 'true',
            'aria-label': 'Emoji',
            'aria-expanded': emojiOpen ? 'true' : 'false',
            onClick: () => setEmojiOpen((value) => !value)
          }, h(Icon, { name: 'smile', size: 19 })),
          h('button', {
            type: 'submit',
            class: 'send-btn',
            'aria-label': 'Send message',
            disabled: !canSend
          }, sending ? h(Spinner) : h(Icon, { name: 'send', size: 18 }))
        )
      ),
      h(
        'div',
        { class: 'composer-foot' },
        h(Icon, { name: active.session.exists ? 'lock' : 'alert', size: 10 }),
        h('span', null, active.session.exists
          ? (active.session.pending ? 'Finishing the secure session' : 'End-to-end encrypted')
          : 'Encryption not ready'),
        draft.length > 5400 ? h('span', { class: 'count' }, `${draft.length}/6000`) : null
      )
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Session state banner                                                       */
/* -------------------------------------------------------------------------- */

function SessionBanner({ app, onRetry }) {
  const { active, auth } = app;
  const peer = active.peer || {};
  const selfId = auth.user?.id;
  const [retrying, setRetrying] = useState(false);

  if (active.sendError) {
    return h(
      'div',
      { class: 'session-banner error' },
      h(Icon, { name: 'alert', size: 17 }),
      h(
        'div',
        { class: 'grow' },
        h('p', { class: 'sb-title' }, 'This message could not be sent'),
        h('p', null, active.sendError),
        h(
          'div',
          { class: 'sb-actions' },
          h(Button, { size: 'sm', variant: 'secondary', onClick: () => mutate((state) => { state.active.sendError = null; }) }, 'Dismiss'),
          !active.session.exists
            ? h(Button, {
                size: 'sm',
                variant: 'soft',
                loading: retrying,
                onClick: async () => {
                  setRetrying(true);
                  try { await onRetry?.(); } catch (error) { toast(errorMessage(error), { tone: 'danger' }); }
                  finally { setRetrying(false); }
                }
              }, 'Retry encryption')
            : null
        )
      )
    );
  }

  if (active.session.pending) {
    return h(
      'div',
      { class: 'session-banner pending' },
      h(Spinner),
      h(
        'div',
        { class: 'grow' },
        h('p', { class: 'sb-title' }, 'Setting up the secure session'),
        h('p', null, 'The first encrypted message carries the handshake. Keep this chat open for a moment.')
      )
    );
  }

  if (active.session.exists) return null;

  const initiator = String(selfId) < String(peer.id);
  return h(
    'div',
    { class: 'session-banner' },
    h(Icon, { name: initiator ? 'shield-check' : 'clock', size: 17 }),
    h(
      'div',
      { class: 'grow' },
      h('p', { class: 'sb-title' }, initiator ? 'Preparing encryption' : 'Encryption is waiting on one step'),
      h(
        'p',
        null,
        initiator
          ? 'Duet is creating the secure session now. This usually finishes before you press send.'
          : `Only ${peer.displayName || 'your contact'} can start the session, so both sides cannot create competing keys. Open Duet there, or ask them to refresh.`
      ),
      h(
        'div',
        { class: 'sb-actions' },
        h(Button, {
          size: 'sm',
          variant: 'soft',
          loading: retrying,
          onClick: async () => {
            setRetrying(true);
            try { await onRetry?.(); } catch (error) { toast(errorMessage(error), { tone: 'danger' }); }
            finally { setRetrying(false); }
          }
        }, initiator ? 'Set up now' : 'Ask to set up')
      )
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Message rows                                                               */
/* -------------------------------------------------------------------------- */

function MessageRow({ item, grouped, mine, peer, onReply, onMenu }) {
  const pressTimer = useRef(null);
  const { row, payload, status } = item;
  const deleted = status === 'deleted' || row.deletedAt;
  const damaged = status === 'damaged';
  const unknownOwn = mine && !payload && !deleted && !damaged;
  const sessionNote = payload?.kind === 'session';
  const media = payload?.kind === 'media';

  if (sessionNote) {
    return h('div', { class: 'system-note' }, 'Secure session established');
  }

  const openMenu = () => {
    if (deleted) return;
    onMenu?.(item);
  };

  const beginPress = () => {
    if (deleted) return;
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(openMenu, 550);
  };
  const endPress = () => clearTimeout(pressTimer.current);

  useEffect(() => () => clearTimeout(pressTimer.current), []);

  const bubbleClass = cx(
    'bubble',
    mine && 'own',
    deleted && 'tombstone',
    damaged && 'damaged',
    media && 'media-bubble'
  );

  return h(
    'div',
    { class: cx('msg-row', mine && 'own', grouped && 'grouped', !grouped && 'show-avatar') },
    !mine
      ? h(Avatar, { name: peer.displayName || '?', color: peer.avatarColor || 0, size: 'sm' })
      : null,
    h(
      'div',
      { class: 'msg-col' },
      h(
        'div',
        {
          class: bubbleClass,
          role: deleted || damaged ? undefined : 'article',
          tabindex: deleted ? undefined : '0',
          onContextMenu: (event) => {
            if (deleted) return;
            event.preventDefault();
            openMenu();
          },
          onPointerDown: beginPress,
          onPointerUp: endPress,
          onPointerLeave: endPress,
          onPointerCancel: endPress,
          onKeyDown: (event) => {
            if (event.key === 'Enter' && event.target === event.currentTarget) {
              event.preventDefault();
              openMenu();
            }
          }
        },
        deleted
          ? h('span', { class: 'row gap-6' }, h(Icon, { name: 'trash', size: 14 }), 'Message deleted')
          : damaged
            ? h(
                'div',
                { class: 'damage-body' },
                h('div', { class: 'row gap-6' }, h(Icon, { name: 'shield', size: 14 }), damageTitle(item.reason)),
                h('p', { class: 'damage-reason' }, damageReason(item.reason)),
                item.retryable
                  ? h(Button, { size: 'sm', variant: 'ghost', class: 'mt-4', onClick: () => retryDamaged() }, 'Try again')
                  : null
              )
            : unknownOwn
              ? h('span', { class: 'row gap-6' }, h(Icon, { name: 'lock', size: 14 }), 'Sent from another device. This device does not have the decrypted copy.')
              : media
                ? h(MediaBubble, { payload })
                : h(
                    'div',
                    null,
                    payload?.replyTo
                      ? h(
                          'div',
                          { class: 'reply-quote' },
                          h('span', { class: 'bar' }),
                          h(
                            'div',
                            { class: 'quote-body' },
                            h('p', { class: 'quote-name' }, payload.replyTo.mine ? 'You' : (peer.displayName || 'Your contact')),
                            h('p', { class: 'quote-text' }, payload.replyTo.preview || 'Message')
                          )
                        )
                      : null,
                    payload?.kind === 'text'
                      ? h(RichText, { text: payload.text || '' })
                      : h('p', { class: 'bubble-text' }, 'This message type is not supported on this version of Duet.')
                  ),
        deleted
          ? null
          : h(
              'div',
              { class: 'bubble-meta' },
              row.editedAt ? h('span', { class: 'edited' }, 'edited') : null,
              h('span', null, formatTime(row.createdAt)),
              mine ? h(MessageStatus, { row }) : null,
              !deleted && !damaged
                ? h('button', {
                    type: 'button',
                    class: 'msg-menu-btn',
                    'aria-label': 'Message actions',
                    onClick: (event) => {
                      event.stopPropagation();
                      openMenu();
                    }
                  }, h(Icon, { name: 'more', size: 12 }))
                : null
            )
      )
    )
  );
}

function RichText({ text }) {
  const parts = String(text).split(/(https?:\/\/[^\s<>()]+)/g);
  return h(
    'span',
    { class: 'bubble-text' },
    parts.map((part, index) => (
      /^https?:\/\//.test(part)
        ? h('a', { key: index, href: part, target: '_blank', rel: 'noopener noreferrer' }, part)
        : part
    ))
  );
}

function MessageStatus({ row }) {
  if (row._status === 'sending') {
    return h('span', { class: 'status', title: 'Sending' }, h(Icon, { name: 'clock', size: 11 }));
  }
  if (row._status === 'failed') {
    return h('button', {
      type: 'button',
      class: 'status failed',
      title: 'Not sent. Tap to retry.',
      'aria-label': 'Not sent. Retry.',
      onClick: (event) => {
        event.stopPropagation();
        retryMessage(row.clientId);
      }
    }, h(Icon, { name: 'alert', size: 12 }));
  }
  if (row.readAt) {
    return h('span', { class: 'status read', title: 'Read' }, h(Icon, { name: 'check-double', size: 13 }));
  }
  if (row.deliveredAt) {
    return h('span', { class: 'status', title: 'Delivered' }, h(Icon, { name: 'check-double', size: 13 }));
  }
  return h('span', { class: 'status', title: 'Sent' }, h(Icon, { name: 'check', size: 12 }));
}

function damageTitle(reason) {
  if (reason === 'no_session') return 'Waiting for the secure session';
  if (reason === 'local_copy_missing') return 'Local copy removed';
  if (reason === 'old_chain' || reason === 'retired_generation') return 'From an older session';
  return 'This message can no longer be read';
}

function damageReason(reason) {
  const map = {
    no_session: 'It will open once both devices finish setting up encryption.',
    local_copy_missing: 'The decrypted copy on this device was cleared. The original ciphertext cannot be read again here.',
    old_chain: 'The session moved on before this device saw it.',
    retired_generation: 'This belongs to a secure session that was deliberately retired.',
    missing_key: 'The key needed for this message is gone.',
    prekey_gone: 'The one-time key used for this message was already consumed.',
    bad_payload: 'The decrypted content was malformed.',
    decrypt_failed: 'Authentication failed. The message may be damaged.'
  };
  return map[reason] || 'The original encryption key is no longer available.';
}

/* -------------------------------------------------------------------------- */
/* Media                                                                      */
/* -------------------------------------------------------------------------- */

function MediaBubble({ payload }) {
  const media = useMediaSource(payload);
  const [opening, setOpening] = useState(false);
  const isVideo = String(payload.mime || '').startsWith('video/');
  const name = payload.name || (isVideo ? 'Video' : 'Photo');

  const open = () => {
    if (!media.url) return;
    setOpening(true);
    openMediaViewer({ payload, name });
  };

  if (media.status === 'loading') {
    return h(
      'div',
      { class: 'media-frame' },
      h(
        'div',
        { class: 'media-loading' },
        h(Spinner),
        h('span', null, 'Decrypting attachment…')
      )
    );
  }

  if (media.status === 'error') {
    return h(
      'div',
      { class: 'media-frame' },
      h(
        'div',
        { class: 'media-error' },
        h(Icon, { name: 'lock', size: 20 }),
        h('span', null, media.error || 'This attachment could not be opened.'),
        h(Button, { size: 'sm', variant: 'secondary', onClick: media.retry }, 'Try again')
      )
    );
  }

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'media-frame' },
      isVideo
        ? h('video', {
            class: 'media-video',
            src: media.url,
            controls: true,
            playsinline: true,
            preload: 'metadata'
          })
        : h('img', {
            class: 'media-image',
            src: media.url,
            alt: name,
            loading: 'lazy',
            style: payload.width && payload.height
              ? { aspectRatio: `${payload.width}/${payload.height}` }
              : undefined,
            onClick: open
          })
    ),
    h(
      'div',
      { class: 'media-caption' },
      h(Icon, { name: isVideo ? 'video' : 'image', size: 12 }),
      h('span', { class: 'name' }, name),
      payload.size ? h('span', { class: 'faint' }, `· ${humanSize(payload.size)}`) : null,
      !isVideo ? h('button', { type: 'button', class: 'link-btn', style: { marginLeft: 'auto' }, onClick: open }, opening ? 'Open' : 'View') : null
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function dayKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function MessageSkeletons() {
  return h(
    'div',
    { class: 'stack-10', 'aria-label': 'Loading messages' },
    h('div', { class: 'msg-row' }, h('div', { class: 'msg-col' }, h(Skeleton, { width: 220, height: 58, radius: 16 }))),
    h('div', { class: 'msg-row own' }, h('div', { class: 'msg-col' }, h(Skeleton, { width: 170, height: 42, radius: 16 }))),
    h('div', { class: 'msg-row' }, h('div', { class: 'msg-col' }, h(Skeleton, { width: 250, height: 74, radius: 16 }))),
    h('div', { class: 'msg-row own' }, h('div', { class: 'msg-col' }, h(Skeleton, { width: 130, height: 42, radius: 16 })))
  );
}
