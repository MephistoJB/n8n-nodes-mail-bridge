class ICloudCredentialsApi {
	constructor() {
		this.name = 'iCloudCredentials';
		this.displayName = 'Apple iCloud IMAP';
		this.properties = [
			{ displayName: 'iCloud Email Address', name: 'mailAddress', type: 'string', default: '', description: 'Full iCloud email address. Existing credentials may instead use the legacy Apple ID field.' },
			{ displayName: 'Apple ID (Legacy)', name: 'appleId', type: 'string', default: '', description: 'Compatibility with existing iCloud credentials; the email address above takes precedence.' },
			{ displayName: 'App Password', name: 'password', type: 'string', typeOptions: { password: true }, default: '', required: true },
		];
	}
}

module.exports = { ICloudCredentialsApi };
