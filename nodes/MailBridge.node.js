'use strict';
const { ImapFlow } = require('imapflow');
const { NodeOperationError } = require('n8n-workflow');
const { transferMailbox } = require('../lib/transfer');
const { connectWithRetry } = require('../lib/connection');

async function close(client) { if (client?.authenticated) await client.logout().catch(() => undefined); }

class MailBridge {
  constructor() {
    this.description = {
      displayName: 'Mail Bridge', name: 'mailBridge', icon: 'file:mailBridge.svg', group: ['transform'], version: 1,
      description: 'Copy RFC822 messages to iCloud; preserve oversized originals and transfer attachment-free copies',
      defaults: { name: 'GMX → iCloud Mail Bridge' }, inputs: ['main'], outputs: ['main'],
      credentials: [{ name: 'imap', required: true }, { name: 'iCloudCredentials', required: true }],
      properties: [
        { displayName: 'Mode', name: 'mode', type: 'options', default: 'transferAndCleanup', options: [
          { name: 'Transfer and Clean Up', value: 'transferAndCleanup' }, { name: 'Transfer Only', value: 'transfer' }, { name: 'Clean Up Only', value: 'cleanup' }] },
        { displayName: 'Source Mailbox', name: 'sourceMailbox', type: 'string', default: 'INBOX' },
        { displayName: 'Archive Mailbox', name: 'archiveMailbox', type: 'string', default: 'sendToicloud' },
        { displayName: 'iCloud Destination Mailbox', name: 'destinationMailbox', type: 'string', default: 'INBOX' },
        { displayName: 'Maximum Messages per Run', name: 'transferLimit', type: 'number', default: 50, typeOptions: { minValue: 1, maxValue: 500 } },
        { displayName: 'Delete Archived Messages Older Than (Months)', name: 'retentionMonths', type: 'number', default: 6, typeOptions: { minValue: 1, maxValue: 120 } },
        { displayName: 'Offload Oversized Attachments', name: 'offloadEnabled', type: 'boolean', default: true },
        { displayName: 'Maximum Full Message Size (MB)', name: 'maxMessageSizeMB', type: 'number', default: 20, typeOptions: { minValue: 1, maxValue: 1000 }, description: 'Complete RFC822 size, decimal MB. Messages exceeding this size are transferred without attachments.' },
        { displayName: 'Oversized Original Mailbox', name: 'oversizedMailbox', type: 'string', default: 'iCloud_zu_gross', description: 'Originals with attachments remain here permanently; never cleaned by archive retention.' },
      ],
    };
  }

  async execute() {
    const sourceCreds = await this.getCredentials('imap');
    const targetCreds = await this.getCredentials('iCloudCredentials');
    const results = [];
    let source;
    let target;
    try {
      source = await connectWithRetry(() => new ImapFlow({ host: sourceCreds.host, port: Number(sourceCreds.port), secure: sourceCreds.secure !== false,
        auth: { user: sourceCreds.user || sourceCreds.username, pass: sourceCreds.password }, logger: false }));
      for (let i = 0; i < this.getInputData().length; i++) {
        const destinationMailbox = this.getNodeParameter('destinationMailbox', i, 'INBOX');
        const getTarget = async () => {
          if (!target?.authenticated) {
            target = await connectWithRetry(() => new ImapFlow({ host: 'imap.mail.me.com', port: 993, secure: true,
              auth: { user: targetCreds.mailAddress || targetCreds.appleId, pass: targetCreds.password }, logger: false }));
          }
          await target.mailboxOpen(destinationMailbox);
          return target;
        };
        const result = await transferMailbox({ source, getTarget,
          account: sourceCreds.host + '/' + (sourceCreds.user || sourceCreds.username),
          sourceMailbox: this.getNodeParameter('sourceMailbox', i, 'INBOX'),
          archiveMailbox: this.getNodeParameter('archiveMailbox', i, 'sendToicloud'), destinationMailbox,
          mode: this.getNodeParameter('mode', i, 'transferAndCleanup'),
          transferLimit: this.getNodeParameter('transferLimit', i, 50),
          retentionMonths: this.getNodeParameter('retentionMonths', i, 6),
          offloadEnabled: this.getNodeParameter('offloadEnabled', i, true),
          oversizedMailbox: this.getNodeParameter('oversizedMailbox', i, 'iCloud_zu_gross'),
          maxBytes: this.getNodeParameter('maxMessageSizeMB', i, 20) * 1000000 });
        results.push({ json: result });
      }
      return [results];
    } catch (error) { throw new NodeOperationError(this.getNode(), String(error.responseText || error.message)); }
    finally { await close(target); await close(source); }
  }
}
module.exports = { MailBridge };
