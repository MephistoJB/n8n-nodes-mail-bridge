const { ImapFlow } = require('imapflow');
const { NodeOperationError } = require('n8n-workflow');

const ICLOUD_IMAP_HOST = 'imap.mail.me.com';

function client(options) { return new ImapFlow({ ...options, logger: false }); }
async function close(client) { if (client && client.authenticated) await client.logout().catch(() => undefined); }

function headerValue(headers, name) {
	const match = headers.match(new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, 'im'));
	return match ? match[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
}

function replaceHeader(headers, name, value) {
	const pattern = new RegExp(`^${name}:.*(?:\\r?\\n[ \\t].*)*\\r?\\n?`, 'gim');
	const line = `${name}: ${value}\r\n`;
	return pattern.test(headers) ? headers.replace(pattern, line) : `${line}${headers}`;
}

function attachmentlessMessage(source) {
	const raw = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
	const headerEnd = raw.search(/\r?\n\r?\n/);
	if (headerEnd === -1) throw new Error('The original message has no RFC822 header block');
	let headers = raw.slice(0, headerEnd);
	const plainStart = raw.search(/^Content-Type:\s*text\/plain\b/im);
	if (plainStart === -1) throw new Error('The original message has no text/plain body that can be copied without attachments');
	const plainHeaderEndRelative = raw.slice(plainStart).search(/\r?\n\r?\n/);
	if (plainHeaderEndRelative === -1) throw new Error('The text/plain part has no header/body separator');
	const plainHeaderEnd = plainStart + plainHeaderEndRelative;
	const plainSeparatorLength = raw.slice(plainHeaderEnd).startsWith('\r\n\r\n') ? 4 : 2;
	const plainHeaders = raw.slice(plainStart, plainHeaderEnd);
	const bodyStart = plainHeaderEnd + plainSeparatorLength;
	const nextBoundary = raw.slice(bodyStart).search(/\r?\n--/);
	const body = nextBoundary === -1 ? raw.slice(bodyStart) : raw.slice(bodyStart, bodyStart + nextBoundary);
	const subject = headerValue(headers, 'Subject') || '(no subject)';

	headers = headers.replace(/^(?:Content-Type|Content-Transfer-Encoding|Content-Disposition|MIME-Version):.*(?:\r?\n[ \t].*)*\r?\n?/gim, '');
	headers = replaceHeader(headers, 'Subject', `${subject} (attachment to big)`);
	headers = replaceHeader(headers, 'X-Mail-Bridge-Attachments-Removed', 'true');
	const contentType = headerValue(plainHeaders, 'Content-Type') || 'text/plain; charset=utf-8';
	const transferEncoding = headerValue(plainHeaders, 'Content-Transfer-Encoding');
	const transferHeader = transferEncoding ? `Content-Transfer-Encoding: ${transferEncoding}\r\n` : '';
	return Buffer.from(`${headers.replace(/\s+$/, '')}\r\nMIME-Version: 1.0\r\nContent-Type: ${contentType}\r\n${transferHeader}\r\n${body}`);
}

function isMessageTooBig(error) {
	return /TOOBIG|too big|message size/i.test(`${error?.responseText || ''} ${error?.response || ''} ${error?.message || ''}`);
}

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
				const tooBigMailbox = 'tobigforicloud';
				const sourceMailbox = this.getNodeParameter('sourceMailbox', itemIndex, 'INBOX');
				let transferred = 0;
				let attachmentStripped = 0;
				let deleted = 0;
				if (mode !== 'cleanup') {
					const destinationMailbox = this.getNodeParameter('destinationMailbox', itemIndex, 'INBOX');
					const transferLimit = this.getNodeParameter('transferLimit', itemIndex, 50);
					const mailboxes = await gmx.list();
					if (!mailboxes.some((mailbox) => mailbox.path === archiveMailbox)) await gmx.mailboxCreate(archiveMailbox);
					if (!mailboxes.some((mailbox) => mailbox.path === tooBigMailbox)) await gmx.mailboxCreate(tooBigMailbox);
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
						try {
							await iCloud.append(destinationMailbox, message.source, flags, message.internalDate || new Date());
							await gmx.messageMove(String(uid), archiveMailbox, { uid: true });
							transferred++;
						} catch (error) {
							if (!isMessageTooBig(error)) throw error;
							await iCloud.append(destinationMailbox, attachmentlessMessage(message.source), flags, message.internalDate || new Date());
							await gmx.messageMove(String(uid), tooBigMailbox, { uid: true });
							attachmentStripped++;
						}
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
				results.push({ json: { success: true, sourceMailbox, archiveMailbox, tooBigMailbox, transferred, attachmentStripped, deleted } });
			}
			return [results];
		} finally { await close(iCloud); await close(gmx); }
	}
}

module.exports = { MailBridge };
