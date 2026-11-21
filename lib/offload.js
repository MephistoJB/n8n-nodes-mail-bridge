'use strict';

const { createHash } = require('node:crypto');
const { simpleParser } = require('mailparser');
const MailComposer = require('nodemailer/lib/mail-composer');

const PREFIX = '[Anhang ausgelagert]';
const KEY_HEADER = 'X-N8N-Mail-Import-Key';

class CannotReduceError extends Error {
  constructor(message) { super(message); this.name = 'CannotReduceError'; }
}

function importKey(raw, account, destinationMailbox) {
  return createHash('sha256').update(JSON.stringify([account, destinationMailbox])).update('\0').update(raw).digest('hex');
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function detachAttachments(raw, { account, destinationMailbox, oversizedMailbox, maxBytes }) {
  const key = importKey(raw, account, destinationMailbox);
  const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const contentType = String(parsed.headers.get('content-type')?.value || '').toLowerCase();
  if (['multipart/encrypted', 'application/pkcs7-mime', 'application/x-pkcs7-mime'].includes(contentType)) {
    throw new CannotReduceError('Verschluesselte Nachricht kann nicht sicher ohne Anhaenge rekonstruiert werden.');
  }
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  let html = typeof parsed.html === 'string' ? parsed.html : '';
  if (!parsed.attachments.length) throw new CannotReduceError('Zu grosse Nachricht enthaelt keine entfernbaren Anhaenge.');
  // Related inline parts are attachments as well. Do not leave broken CID images.
  html = html.replace(/<img\b[^>]*\bsrc\s*=\s*(["'])cid:[^"']+\1[^>]*>/gi, '<span>[Inline-Abbildung im ausgelagerten Original]</span>')
    .replace(/url\(\s*(["']?)cid:[^)]+\)/gi, 'none');
  const filenames = parsed.attachments.map(a => a.filename || 'Anhang ohne Dateiname');
  const note = 'Anhaenge ausgelagert. Das vollstaendige Original mit allen Anhaengen bleibt im Quellkonto '
    + account + ' im Ordner ' + oversizedMailbox + ' erhalten.\n'
    + 'Original-Message-ID: ' + (parsed.messageId || '(nicht vorhanden)') + '\n'
    + 'Ausgelagerte Dateien: ' + filenames.join(', ');
  const cleanSubject = String(parsed.subject || '(ohne Betreff)').replace(/^(?:\[Anhang ausgelagert\]\s*)+/i, '').replace(/[\r\n]+/g, ' ');
  const headers = { [KEY_HEADER]: key, 'X-N8N-Attachment-Offload': 'yes' };
  if (parsed.messageId) headers['X-Original-Message-ID'] = parsed.messageId;
  const options = {
    from: parsed.from?.value, to: parsed.to?.value, cc: parsed.cc?.value, bcc: parsed.bcc?.value,
    replyTo: parsed.replyTo?.value, date: parsed.date, inReplyTo: parsed.inReplyTo, references: parsed.references,
    subject: PREFIX + ' ' + cleanSubject,
    messageId: '<offloaded.' + key + '@mail-bridge.invalid>',
    text: (text ? text + '\n\n' : '') + '---\n' + note,
    html: html ? html + '<hr><p>' + escapeHtml(note).replace(/\n/g, '<br>') + '</p>' : undefined,
    headers, attachments: [], newline: 'windows', keepBcc: true, disableFileAccess: true, disableUrlAccess: true,
  };
  const compiled = new MailComposer(options).compile();
  compiled.keepBcc = true;
  const reduced = await new Promise((resolve, reject) => compiled.build((err, result) => err ? reject(err) : resolve(result)));
  if (reduced.length > maxBytes) throw new CannotReduceError('Nachricht bleibt auch ohne Anhaenge zu gross; Text wird nicht gekuerzt.');
  return { raw: reduced, key, removedAttachments: parsed.attachments.length, subject: options.subject };
}

module.exports = { detachAttachments, importKey, KEY_HEADER, PREFIX, CannotReduceError };
