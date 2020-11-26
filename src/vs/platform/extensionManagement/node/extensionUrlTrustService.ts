/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as qs from 'querystring';
import { URI } from 'vs/base/common/uri';
import { IExtensionUrlTrustService } from 'vs/platform/extensionManagement/common/extensionUrlTrust';
import { ILogService } from 'vs/platform/log/common/log';
import { IProductService } from 'vs/platform/product/common/productService';

export class ExtensionUrlTrustService implements IExtensionUrlTrustService {

	declare readonly _serviceBrand: undefined;

	private trustedExtensionUrlPublicKeys = new Map<string, (crypto.KeyObject | string | null)[]>();

	constructor(
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService
	) { }

	async isExtensionUrlTrusted(uri: URI): Promise<boolean> {
		if (!this.productService.trustedExtensionUrlPublicKeys) {
			this.logService.trace('ExtensionUrlTrustService#isExtensionUrlTrusted', 'There are no configured trusted keys');
			return false;
		}

		const extensionId = uri.authority;
		let keys = this.trustedExtensionUrlPublicKeys.get(extensionId);

		if (!keys) {
			keys = this.productService.trustedExtensionUrlPublicKeys[extensionId];

			if (!keys) {
				this.logService.trace('ExtensionUrlTrustService#isExtensionUrlTrusted', 'Extension doesn\'t have any trusted keys', extensionId);
				return false;
			}

			this.trustedExtensionUrlPublicKeys.set(extensionId, [...keys]);
		}

		const { ts: rawTimestamp, sign } = qs.parse(uri.query);

		if (!sign || typeof sign !== 'string') {
			this.logService.trace('ExtensionUrlTrustService#isExtensionUrlTrusted', 'Uri is not signed', uri);
			return false;
		}

		if (!rawTimestamp || typeof rawTimestamp !== 'string') {
			this.logService.trace('ExtensionUrlTrustService#isExtensionUrlTrusted', 'Signed uri doesn\'t have timestamp', uri);
			return false;
		}

		const now = Date.now();
		const timestamp = Number.parseInt(rawTimestamp);
		const diff = now - timestamp;

		if (diff < 0 || diff > 600_000) { // 10 minutes
			this.logService.trace('ExtensionUrlTrustService#isExtensionUrlTrusted', 'Signed uri has expired', uri);
			return false;
		}

		const unsignedQuery = uri.query.replace(/(&|\?)sign=[^&]+(&?)/, (_1, prefix, suffix) => prefix === '?' ? '?' : suffix);
		const unsignedUri = URI.from({ ...uri, query: unsignedQuery });
		const verify = crypto.createVerify('SHA256');
		verify.write(unsignedUri);
		verify.end();

		for (let i = 0; i < keys.length; i++) {
			let key = keys[i];

			if (key === null) { // failed to be parsed before
				continue;
			} else if (typeof key === 'string') { // needs to be parsed
				try {
					key = crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
					keys[i] = key;
				} catch (err) {
					this.logService.warn('ExtensionUrlTrustService#isExtensionUrlTrusted', `Failed to parse trusted extension uri public key #${i + 1} for ${extensionId}:`, err);
					keys[i] = null;
					continue;
				}
			}

			if (verify.verify(key, sign, 'base64')) {
				this.logService.trace('ExtensionUrlTrustService#isExtensionUrlTrusted', 'Signed uri is valid', uri);
				return true;
			}
		}

		this.logService.trace('ExtensionUrlTrustService#isExtensionUrlTrusted', 'Signed uri could not be verified', uri);
		return false;
	}
}

