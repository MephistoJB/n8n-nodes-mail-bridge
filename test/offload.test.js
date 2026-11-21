'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MailComposer = require('nodemailer/lib/mail-composer');
const { simpleParser } = require('mailparser');
const { detachAttachments, importKey, KEY_HEADER, CannotReduceError } = require('../lib/offload');
const { transferMailbox, mailboxPath } = require('../lib/transfer');

async function fixture(overrides = {}) {
  const compiled = new MailComposer({
    from: 'Jöhn <sender@example.invalid>', to: 'Receiver <to@example.invalid>', cc: 'cc@example.invalid', bcc: 'hidden@example.invalid',
    replyTo: 'reply@example.invalid', date: new Date('2024-02-24T08:11:57Z'), subject: 'Reisebestätigung – Grüße',
    messageId: '<original@example.invalid>', inReplyTo: '<prior@example.invalid>', references: ['<prior@example.invalid>'],
    headers: { 'DKIM-Signature': 'old-signature-must-not-survive' },
    text: 'Originaltext mit Umlauten: Grüße und 東京.',
    html: '<p>Originaltext mit Umlauten: Grüße und 東京.</p><img src="cid:logo@example.invalid">',
    attachments: [{ filename: 'Reiseunterlagen.pdf', content: Buffer.alloc(18000, 65), contentType: 'application/pdf' },
      { filename: 'Bild.png', cid: 'logo@example.invalid', content: Buffer.alloc(8000, 66), contentType: 'image/png' }],
    ...overrides,
  }).compile();
  compiled.keepBcc = true;
  return await new Promise((resolve, reject) => compiled.build((e, b) => e ? reject(e) : resolve(b)));
}

const settings = { account: 'imap.example.invalid/user@example.invalid', destinationMailbox: 'Sent Messages', oversizedMailbox: 'iCloud_zu_gross_Gesendet', maxBytes: 6000 };

test('strips ordinary and inline attachments while preserving content and mail metadata', async () => {
  const raw = await fixture();
  const original = Buffer.from(raw);
  const reduced = await detachAttachments(raw, settings);
  const parsed = await simpleParser(reduced.raw);
  assert.deepEqual(raw, original);
  assert.equal(parsed.attachments.length, 0);
  assert.equal(reduced.removedAttachments, 2);
  assert.equal(parsed.subject, '[Anhang ausgelagert] Reisebestätigung – Grüße');
  assert.ok(parsed.text.includes('Originaltext mit Umlauten: Grüße und 東京.'));
  assert.ok(parsed.html.includes('Originaltext mit Umlauten: Grüße und 東京.'));
  assert.ok(!parsed.html.includes('cid:logo'));
  assert.ok(parsed.text.includes(settings.oversizedMailbox));
  assert.ok(parsed.text.includes('Reiseunterlagen.pdf'));
  assert.equal(parsed.from.value[0].address, 'sender@example.invalid');
  assert.equal(parsed.to.value[0].address, 'to@example.invalid');
  assert.equal(parsed.cc.value[0].address, 'cc@example.invalid');
  assert.equal(parsed.bcc.value[0].address, 'hidden@example.invalid');
  assert.equal(parsed.replyTo.value[0].address, 'reply@example.invalid');
  assert.equal(parsed.date.toISOString(), '2024-02-24T08:11:57.000Z');
  assert.equal(parsed.inReplyTo, '<prior@example.invalid>');
  assert.equal(parsed.headers.get(KEY_HEADER.toLowerCase()), reduced.key);
  assert.equal(parsed.headers.get('x-original-message-id'), '<original@example.invalid>');
  assert.ok(!parsed.headers.has('dkim-signature'));
  assert.ok(reduced.raw.length < settings.maxBytes);
});

test('subject prefix is applied exactly once and identity is stable across source folders', async () => {
  const raw = await fixture({ subject: '[Anhang ausgelagert] [Anhang ausgelagert] Reise' });
  const one = await detachAttachments(raw, settings);
  const two = await detachAttachments(raw, settings);
  assert.equal(one.subject, '[Anhang ausgelagert] Reise');
  assert.equal(one.key, two.key);
  assert.notEqual(one.key, importKey(raw, settings.account, 'INBOX'));
  assert.notEqual(one.key, importKey(raw, 'other-account', settings.destinationMailbox));
});

test('does not truncate a body that cannot fit and does not manufacture decrypted content', async () => {
  const noAttachments = await fixture({ text: 'x'.repeat(20000), html: false, attachments: [] });
  await assert.rejects(detachAttachments(noAttachments, settings), CannotReduceError);
  const largeBody = await fixture({ text: 'x'.repeat(20000), html: false });
  await assert.rejects(detachAttachments(largeBody, settings), /Text wird nicht gekuerzt/);
  const encrypted = Buffer.from('From: a@example.invalid\r\nTo: b@example.invalid\r\nMIME-Version: 1.0\r\nContent-Type: application/pkcs7-mime\r\nContent-Transfer-Encoding: base64\r\n\r\nYWJj\r\n');
  await assert.rejects(detachAttachments(encrypted, settings), /Verschluesselte Nachricht/);
});

function fakeSource(messages, options = {}) {
  const client = { namespace: { prefix: options.prefix || '' }, selected: 'INBOX',
    messages: new Map(messages.map((m, i) => [i + 1, { folder: 'INBOX', flags: new Set(['\\Seen']), internalDate: new Date('2024-02-24T08:11:57Z'), ...m }])),
    boxes: new Set(['INBOX']), deletions: [], moves: [], failMoveOnce: false,
    path(p) { return mailboxPath(this, p); },
    async list() { return [...this.boxes].map(path => ({ path })); },
    async mailboxCreate(p) { this.boxes.add(this.path(p)); return true; },
    async mailboxOpen(p) { this.selected = this.path(p); return { path: this.selected }; },
    async search(query) { return [...this.messages].filter(([,m]) => m.folder === this.selected && (!query.before || m.internalDate < query.before)).map(([uid]) => uid); },
    async *fetch(uid) { const m = this.messages.get(Number(uid)); if (m?.folder === this.selected) yield { uid: Number(uid), ...m }; },
    async messageMove(uid, folder) { if (this.failMoveOnce) { this.failMoveOnce = false; throw new Error('simulated move interruption'); } const m = this.messages.get(Number(uid)); assert.equal(m.folder, this.selected); m.folder = this.path(folder); this.moves.push({ uid: Number(uid), folder: m.folder }); return { uid: Number(uid) }; },
    async messageDelete(uids) { for (const uid of uids) { assert.equal(this.messages.get(uid).folder, this.selected); this.deletions.push(uid); this.messages.delete(uid); } return true; },
  };
  return client;
}

function fakeTarget(options = {}) {
  return { appends: [], keys: new Set(),
    async search(query) { return this.keys.has(query.header[KEY_HEADER]) ? [42] : []; },
    async append(mailbox, raw, flags, date) {
      if (options.fail || (options.rejectOriginal && raw.length > 6000)) { const e = new Error('Command failed'); e.responseText = options.fail || 'Cannot upload message, TOOBIG'; throw e; }
      const parsed = await simpleParser(raw);
      const key = parsed.headers.get(KEY_HEADER.toLowerCase()); if (key) this.keys.add(key);
      this.appends.push({ mailbox, raw: Buffer.from(raw), flags, date }); return { uid: this.appends.length };
    },
  };
}

async function run(source, target, overrides = {}) {
  return await transferMailbox({ source, getTarget: async () => target, account: settings.account,
    sourceMailbox: 'INBOX', archiveMailbox: 'sendToicloud', destinationMailbox: settings.destinationMailbox,
    mode: 'transfer', transferLimit: 50, retentionMonths: 6, offloadEnabled: true,
    oversizedMailbox: settings.oversizedMailbox, maxBytes: settings.maxBytes, ...overrides });
}

test('offloaded originals remain unchanged in an exception folder and retain Seen/internalDate', async () => {
  const raw = await fixture(); const source = fakeSource([{ source: raw }]); const target = fakeTarget();
  const r = await run(source, target);
  assert.equal(r.success, true); assert.equal(r.transferred, 1); assert.equal(r.offloaded, 1);
  assert.equal(source.messages.get(1).folder, settings.oversizedMailbox);
  assert.deepEqual(source.messages.get(1).source, raw);
  assert.deepEqual(target.appends[0].flags, ['\\Seen']);
  assert.equal(target.appends[0].date.toISOString(), '2024-02-24T08:11:57.000Z');
});

test('retry after append/move interruption avoids a second copy, including archive backfill', async () => {
  const raw = await fixture(); const source = fakeSource([{ source: raw }]); const target = fakeTarget();
  source.failMoveOnce = true;
  const first = await run(source, target); assert.equal(first.success, false); assert.equal(target.appends.length, 1);
  assert.equal(source.messages.get(1).folder, 'INBOX');
  const second = await run(source, target); assert.equal(second.success, true); assert.equal(second.duplicatesSkipped, 1);
  assert.equal(target.appends.length, 1); assert.equal(source.messages.get(1).folder, settings.oversizedMailbox);
  const backfill = await run(source, target, { sourceMailbox: settings.oversizedMailbox });
  assert.equal(backfill.duplicatesSkipped, 1); assert.equal(target.appends.length, 1);
  assert.equal(source.messages.get(1).folder, settings.oversizedMailbox);
});

test('ordinary messages are byte-preserved and cleaned normally; oversized originals never expire', async () => {
  const small = await fixture({ attachments: [], html: false }); const big = await fixture();
  const source = fakeSource([{ source: small },{ source: big }]); const target = fakeTarget();
  const r = await run(source, target, { mode: 'transferAndCleanup' });
  assert.equal(r.success, true); assert.equal(r.deleted, 1);
  assert.deepEqual(source.deletions, [1]); assert.equal(source.messages.get(2).folder, settings.oversizedMailbox);
  assert.equal(target.appends.filter(a => a.raw.equals(small)).length, 1);
});

test('server TOOBIG can trigger offloading even below the configured preflight threshold', async () => {
  const source = fakeSource([{ source: await fixture() }]); const target = fakeTarget({ rejectOriginal: true });
  const r = await run(source, target, { maxBytes: 100000 });
  assert.equal(r.success, true); assert.equal(r.offloaded, 1); assert.equal(target.appends.length, 1);
});

test('a single irreducible oversized message is preserved and does not block another message', async () => {
  const small = await fixture({ attachments: [], html: false });
  const largeText = await fixture({ text: 'x'.repeat(20000), attachments: [], html: false });
  const source = fakeSource([{ source: small },{ source: largeText }]); const target = fakeTarget();
  const r = await run(source, target);
  assert.equal(r.success, false); assert.equal(r.transferred, 1); assert.equal(r.preservedWithoutCopy, 1);
  assert.equal(source.messages.get(2).folder, settings.oversizedMailbox);
  assert.equal(source.messages.get(1).folder, 'sendToicloud');
  assert.equal(target.appends.length, 1);
});

test('append failure leaves the original in place; namespace handling and cleanup guards are strict', async () => {
  const raw = await fixture(); const source = fakeSource([{ source: raw }]);
  const r = await run(source, fakeTarget({ fail: 'temporary storage error' }));
  assert.equal(r.success, false); assert.equal(source.messages.get(1).folder, 'INBOX');
  assert.equal(mailboxPath({ namespace:{ prefix:'INBOX.' } }, 'iCloud_zu_gross'), 'INBOX.iCloud_zu_gross');
  assert.equal(mailboxPath({ namespace:{ prefix:'INBOX.' } }, 'INBOX'), 'INBOX');
  await assert.rejects(run(source, fakeTarget(), { archiveMailbox: settings.oversizedMailbox }), /Ausnahmeordner/);
});

test('empty mailboxes do not connect to iCloud', async () => {
  let connected = false;
  const r = await transferMailbox({ source: fakeSource([]), getTarget: async () => { connected = true; throw Error('unnecessary connection'); },
    account: settings.account, sourceMailbox:'INBOX', archiveMailbox:'sendToicloud', destinationMailbox:'INBOX',
    mode:'transfer', transferLimit:50, retentionMonths:6, offloadEnabled:true, oversizedMailbox:'iCloud_zu_gross', maxBytes:6000 });
  assert.equal(r.success, true); assert.equal(connected, false);
});
