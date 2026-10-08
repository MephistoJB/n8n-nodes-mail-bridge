const { ImapFlow } = require('imapflow');
const { NodeOperationError } = require('n8n-workflow');

const ICLOUD_IMAP_HOST = 'imap.mail.me.com';

function client(options) { return new ImapFlow({ ...options, logger: false }); }
async function close(client) { if (client && client.authenticated) await client.logout().catch(() => undefined); }

class MailBridge {
	constructor() {
		this.description = {
			displayName: 'Mail Bridge', name: 'mailBridge', icon: 'file:mailBridge.svg', group: ['transform'], version: 1,
			description: 'Copy complete RFC822 messages from GMX to iCloud, then archive and expire the GMX copies',
			defaults: { name: 'GMX → iCloud Mail Bridge' }, inputs: ['main'], outputs: ['main'],
			credentials: [{ name: 'imap', required: true }, { name: 'iCloudCredentials', required: true }],
			properties: [
				{ displayName: 'Mode', name: 'mode', type: 'options', default: 'transferAndCleanup', options: [{ name: 'Transfer and Clean Up', value: 'transferAndCleanup' }, { name: 'Transfer Only', value: 'transfer' }, { name: 'Clean Up Only', value: 'cleanup' }] },
				{ displayName: 'GMX Source Mailbox', name: 'sourceMailbox', type: 'string', default: 'INBOX', displayOptions: { hide: { mode: ['cleanup'] } } },
				{ displayName: 'GMX Archive Mailbox', name: 'archiveMailbox', type: 'string', default: 'sendToicloud' },
				{ displayName: 'iCloud Destination Mailbox', name: 'destinationMailbox', type: 'string', default: 'INBOX', displayOptions: { hide: { mode: ['cleanup'] } } },
				{ displayName: 'Maximum Messages per Run', name: 'transferLimit', type: 'number', default: 50, typeOptions: { minValue: 1, maxValue: 500 }, displayOptions: { hide: { mode: ['cleanup'] } } },
				{ displayName: 'Delete Archived Messages Older Than (Months)', name: 'retentionMonths', type: 'number', default: 6, typeOptions: { minValue: 1, maxValue: 120 }, displayOptions: { hide: { mode: ['transfer'] } } },
			],
		};
	}

	async execute() {
		const results = [];
		const gmxCredentials = await this.getCredentials('imap');
		const iCloudCredentials = await this.getCredentials('iCloudCredentials');
		const gmx = client({ host: gmxCredentials.host, port: Number(gmxCredentials.port), secure: gmxCredentials.secure !== false, auth: { user: gmxCredentials.user || gmxCredentials.username, pass: gmxCredentials.password } });
		let iCloud;
		try {
			await gmx.connect();
			for (let itemIndex = 0; itemIndex < this.getInputData().length; itemIndex++) {
				const mode = this.getNodeParameter('mode', itemIndex);
				const archiveMailbox = this.getNodeParameter('archiveMailbox', itemIndex);
				const sourceMailbox = this.getNodeParameter('sourceMailbox', itemIndex, 'INBOX');
				let transferred = 0;
				let deleted = 0;
				if (mode !== 'cleanup') {
					const destinationMailbox = this.getNodeParameter('destinationMailbox', itemIndex, 'INBOX');
					const transferLimit = this.getNodeParameter('transferLimit', itemIndex, 50);
					const mailboxes = await gmx.list();
					if (!mailboxes.some((mailbox) => mailbox.path === archiveMailbox)) await gmx.mailboxCreate(archiveMailbox);
					await gmx.mailboxOpen(sourceMailbox);
					const found = await gmx.search({ all: true }, { uid: true });
					const uids = (Array.isArray(found) ? found : []).slice(-transferLimit);
					iCloud = client({ host: ICLOUD_IMAP_HOST, port: 993, secure: true, auth: { user: iCloudCredentials.mailAddress || iCloudCredentials.appleId, pass: iCloudCredentials.password } });
					await iCloud.connect();
					await iCloud.mailboxOpen(destinationMailbox);
					for (const uid of uids) {
						let message;
						for await (const fetched of gmx.fetch(String(uid), { uid: true, source: true, flags: true, internalDate: true }, { uid: true })) { message = fetched; break; }
						if (!message || !message.source) throw new NodeOperationError(this.getNode(), `GMX message ${uid} could not be read as original RFC822 data`, { itemIndex });
						const flags = message.flags && message.flags.has('\\Seen') ? ['\\Seen'] : [];
						await iCloud.append(destinationMailbox, message.source, flags, message.internalDate || new Date());
						await gmx.messageMove(String(uid), archiveMailbox, { uid: true });
						transferred++;
					}
					await close(iCloud); iCloud = undefined;
				}
				if (mode !== 'transfer') {
					const retentionMonths = this.getNodeParameter('retentionMonths', itemIndex, 6);
					const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - retentionMonths);
					await gmx.mailboxOpen(archiveMailbox);
					const oldMessages = await gmx.search({ before: cutoff }, { uid: true });
					const oldUids = Array.isArray(oldMessages) ? oldMessages : [];
					if (oldUids.length) await gmx.messageDelete(oldUids, { uid: true });
					deleted = oldUids.length;
				}
				results.push({ json: { success: true, sourceMailbox, archiveMailbox, transferred, deleted } });
			}
			return [results];
		} finally { await close(iCloud); await close(gmx); }
	}
}

module.exports = { MailBridge };
