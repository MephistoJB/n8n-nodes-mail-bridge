class ICloudCredentialsApi {
	constructor() {
		this.name = 'iCloudCredentials';
		this.displayName = 'Apple iCloud IMAP';
		this.properties = [
			{ displayName: 'iCloud Email Address', name: 'mailAddress', type: 'string', default: '', required: true },
			{ displayName: 'App Password', name: 'password', type: 'string', typeOptions: { password: true }, default: '', required: true },
		];
	}
}

module.exports = { ICloudCredentialsApi };
