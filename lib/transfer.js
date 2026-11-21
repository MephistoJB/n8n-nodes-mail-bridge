'use strict';

const { detachAttachments, importKey, KEY_HEADER, CannotReduceError } = require('./offload');

function mailboxPath(client, path) {
  const prefix = client.namespace?.prefix || '';
  return prefix && path.toUpperCase() !== 'INBOX' && !path.startsWith(prefix) ? prefix + path : path;
}

async function ensureMailbox(client, configuredPath) {
  const path = mailboxPath(client, configuredPath);
  const boxes = await client.list();
  if (!boxes.some(box => box.path === path || box.path === configuredPath)) {
    try { await client.mailboxCreate(configuredPath); }
    catch (error) { if (!/already.?exists/i.test(String(error.responseText || error.message))) throw error; }
  }
  return path;
}

function isTooBig(error) {
  return /TOOBIG|message.{0,30}too (?:big|large)|maximum message size/i.test(String(error.responseText || error.response || error.message || ''));
}

async function transferMailbox({ source, getTarget, account, sourceMailbox, archiveMailbox, destinationMailbox,
  mode, transferLimit, retentionMonths, offloadEnabled, oversizedMailbox, maxBytes }) {
  const result = { success: true, sourceMailbox, archiveMailbox, destinationMailbox, oversizedMailbox,
    transferred: 0, deleted: 0, offloaded: 0, duplicatesSkipped: 0, preservedWithoutCopy: 0, errors: [] };
  const sourcePath = mailboxPath(source, sourceMailbox);
  const archivePath = mailboxPath(source, archiveMailbox);
  const oversizedPath = mailboxPath(source, oversizedMailbox);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Ungueltige maximale Nachrichtengroesse.');
  if (!Number.isInteger(transferLimit) || transferLimit < 1 || transferLimit > 500) throw new Error('Ungueltiges Nachrichtenlimit.');
  if (!offloadEnabled && sourcePath === oversizedPath && mode !== 'cleanup') throw new Error('Ausnahmeordner darf nur mit aktiver Anhang-Auslagerung nachgezogen werden.');
  if (offloadEnabled && archivePath === oversizedPath) throw new Error('Original-Ausnahmeordner darf nicht als bereinigtes Archiv verwendet werden.');
  const preserveOriginal = async uid => {
    if (sourcePath === oversizedPath) return;
    await ensureMailbox(source, oversizedMailbox);
    const moved = await source.messageMove(String(uid), oversizedMailbox, { uid: true });
    if (!moved) throw new Error('Verschiebung des Originals in den Ausnahmeordner nicht bestaetigt.');
  };
  if (mode !== 'cleanup') {
    await ensureMailbox(source, archiveMailbox);
    await source.mailboxOpen(sourceMailbox);
    const found = await source.search({ all: true }, { uid: true });
    const uids = (Array.isArray(found) ? found : []).slice(-transferLimit).reverse();
    let target;
    for (const uid of uids) {
      try {
        let message;
        // Consume the complete fetch iterator before issuing another source command.
        for await (const fetched of source.fetch(String(uid), { uid: true, source: true, flags: true, internalDate: true, size: true }, { uid: true })) message = fetched;
        if (!message?.source) throw new Error('Originale RFC822-Nachricht konnte nicht gelesen werden.');
        const flags = message.flags?.has('\\Seen') ? ['\\Seen'] : [];
        const internalDate = message.internalDate || new Date();
        const oversized = offloadEnabled && (message.source.length > maxBytes || sourcePath === oversizedPath);
        const deliverReduced = async () => {
          const key = importKey(message.source, account, destinationMailbox);
          target ||= await getTarget();
          const existing = await target.search({ header: { [KEY_HEADER]: key } }, { uid: true });
          if (Array.isArray(existing) && existing.length) result.duplicatesSkipped++;
          else {
            const reduced = await detachAttachments(message.source, { account, destinationMailbox, oversizedMailbox, maxBytes });
            const appended = await target.append(destinationMailbox, reduced.raw, flags, internalDate);
            if (!appended) throw new Error('Append der anhanglosen Kopie nicht bestaetigt.');
            result.transferred++;
            result.offloaded++;
          }
          await preserveOriginal(uid);
        };
        if (oversized) await deliverReduced();
        else {
          target ||= await getTarget();
          try {
            const appended = await target.append(destinationMailbox, message.source, flags, internalDate);
            if (!appended) throw new Error('Append der Originalnachricht nicht bestaetigt.');
          } catch (error) {
            if (!offloadEnabled || !isTooBig(error)) throw error;
            await deliverReduced();
            continue;
          }
          result.transferred++;
          if (sourcePath === oversizedPath) throw new Error('Kleine Nachricht im Ausnahmeordner bleibt zur manuellen Pruefung erhalten.');
          const moved = await source.messageMove(String(uid), archiveMailbox, { uid: true });
          if (!moved) throw new Error('Verschiebung nach bestaetigtem Append fehlgeschlagen.');
        }
      } catch (error) {
        let preserved = false;
        if (error instanceof CannotReduceError) {
          try { await preserveOriginal(uid); result.preservedWithoutCopy++; preserved = true; }
          catch (moveError) { error = new Error(error.message + ' Originalverschiebung fehlgeschlagen: ' + moveError.message); }
        }
        result.errors.push({ uid, error: String(error.responseText || error.message), originalInExceptionFolder: preserved });
      }
    }
  }
  if (mode !== 'transfer') {
    // The original exception folder is never included in this retention cleanup.
    if (archivePath === oversizedPath) throw new Error('Bereinigung des Original-Ausnahmeordners ist untersagt.');
    try {
      await ensureMailbox(source, archiveMailbox);
      const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - retentionMonths);
      await source.mailboxOpen(archiveMailbox);
      const old = await source.search({ before: cutoff }, { uid: true });
      if (Array.isArray(old) && old.length) {
        if (!await source.messageDelete(old, { uid: true })) throw new Error('Archivbereinigung nicht bestaetigt.');
        result.deleted = old.length;
      }
    } catch (error) { result.errors.push({ error: 'Archivbereinigung: ' + String(error.responseText || error.message) }); }
  }
  result.success = result.errors.length === 0;
  result.error = result.errors.map(e => (e.uid ? 'UID ' + e.uid + ': ' : '') + e.error).join('; ');
  return result;
}

module.exports = { transferMailbox, ensureMailbox, mailboxPath, isTooBig };
