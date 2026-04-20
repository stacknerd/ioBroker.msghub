/**
 * IoSystemBaseline
 * ================
 * Adapter-side system baseline owner for MsgHub.
 *
 * Docs: ../docs/io/IoSystemBaseline.md
 *
 * Responsibilities
 * - Ensure the canonical MsgHub-owned public-web reference user exists.
 * - Ensure the canonical MsgHub-owned public-web reference group exists.
 * - Enforce canonical membership, ACL, icon, and enabled flags on every startup.
 * - Set a fresh controller-managed password for the canonical reference user.
 *
 * Non-responsibilities
 * - No mutations of foreign admin-managed users or groups.
 * - No automatic writes to `system.adapter.web.*.native.defaultUser`.
 * - No use of `MsgConfig` or core-layer config normalization for system-object provisioning.
 */

'use strict';

const crypto = require('node:crypto');

/**
 * Adapter-side owner for the MsgHub system baseline.
 */
class IoSystemBaseline {
	/**
	 * @param {object} [options] Constructor options.
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string }} [options.adapter]
	 *   ioBroker adapter instance.
	 */
	constructor({ adapter } = {}) {
		if (!adapter?.namespace) {
			throw new Error('IoSystemBaseline: adapter is required');
		}
		this.adapter = adapter;
	}

	/**
	 * Ensure the full MsgHub-owned public-web reference baseline.
	 *
	 * The method is intentionally strict for the canonical MsgHub objects only.
	 *
	 * @returns {Promise<void>} Resolves when the baseline is ensured.
	 */
	async ensure() {
		await this._ensureUser();
		await this._ensureGroup();
		await this._ensureMembership();
		await this._ensurePassword();
	}

	/**
	 * Build the canonical reference ids and labels.
	 *
	 * @returns {{
	 *   groupId: 'system.group.msghub_web',
	 *   groupShortName: 'msghub_web',
	 *   groupName: 'MessageHub Web',
	 *   groupDesc: 'Built-in MessageHub user group for web access.',
	 *   userId: 'system.user.msghub_webapp_user',
	 *   userShortName: 'msghub_webapp_user',
	 *   userName: 'MessageHub WebApp User',
	 *   userDesc: 'Built-in MessageHub user for an ioBroker.web instance used by the WebApp.',
	 *   icon: '/adapter/msghub/msghub.png'
	 * }} Canonical baseline ids and labels.
	 */
	_buildReferenceIds() {
		return {
			groupId: 'system.group.msghub_web',
			groupShortName: 'msghub_web',
			groupName: 'MessageHub Web',
			groupDesc: 'Built-in MessageHub user group for web access.',
			userId: 'system.user.msghub_webapp_user',
			userShortName: 'msghub_webapp_user',
			userName: 'MessageHub WebApp User',
			userDesc: 'Built-in MessageHub user for an ioBroker.web instance used by the WebApp.',
			icon: '/adapter/msghub/msghub.png',
		};
	}

	/**
	 * Build the canonical ACL for the MsgHub-owned web group.
	 *
	 * @returns {object} Canonical ACL object.
	 */
	_buildReferenceAcl() {
		return {
			file: { list: false, read: false, write: false, create: false, delete: false },
			object: { list: false, read: false, write: false, create: false, delete: false },
			users: { list: false, read: false, write: false, create: false, delete: false },
			state: { list: false, read: false, write: false, create: false, delete: false },
			other: { execute: false, http: true, sendto: false },
		};
	}

	/**
	 * Build the canonical user object while preserving unrelated existing metadata when possible.
	 *
	 * @param {ioBroker.Object | null | undefined} existing Existing object.
	 * @returns {ioBroker.UserObject} Canonical user object.
	 */
	_buildUserObject(existing) {
		const ids = this._buildReferenceIds();
		const current = this._isRecord(existing) ? existing : {};
		const common = this._isRecord(current.common) ? current.common : {};
		const native = this._isRecord(current.native) ? current.native : {};
		return {
			...current,
			_id: ids.userId,
			type: 'user',
			common: {
				...common,
				name: ids.userName,
				desc: ids.userDesc,
				password: typeof common.password === 'string' ? common.password : '',
				enabled: true,
				icon: ids.icon,
			},
			native: { ...native },
		};
	}

	/**
	 * Build the canonical group object while preserving unrelated existing metadata when possible.
	 *
	 * @param {ioBroker.Object | null | undefined} existing Existing object.
	 * @returns {ioBroker.GroupObject} Canonical group object.
	 */
	_buildGroupObject(existing) {
		const ids = this._buildReferenceIds();
		const current = this._isRecord(existing) ? existing : {};
		const common = this._isRecord(current.common) ? current.common : {};
		const native = this._isRecord(current.native) ? current.native : {};
		return {
			...current,
			_id: ids.groupId,
			type: 'group',
			common: {
				...common,
				name: ids.groupName,
				desc: ids.groupDesc,
				members: this._normalizeMembers([ids.userId]),
				acl: this._buildReferenceAcl(),
				enabled: true,
				icon: ids.icon,
			},
			native: { ...native },
		};
	}

	/**
	 * Generate one random password that satisfies the agreed baseline policy.
	 *
	 * @returns {string} Generated password.
	 */
	_generatePassword() {
		const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
		const lower = 'abcdefghijklmnopqrstuvwxyz';
		const digits = '0123456789';
		const special = '!#$%&()*+,-./:;=?@[]^_{|}~';
		const all = `${upper}${lower}${digits}${special}`;
		const picks = [
			this._pickRandomChar(upper),
			this._pickRandomChar(lower),
			this._pickRandomChar(digits),
			this._pickRandomChar(special),
		];
		while (picks.length < 16) {
			picks.push(this._pickRandomChar(all));
		}
		return this._shuffleChars(picks).join('');
	}

	/**
	 * Ensure the canonical user object exists and matches the baseline fields.
	 *
	 * @returns {Promise<void>} Resolves when the user object is correct.
	 */
	async _ensureUser() {
		const ids = this._buildReferenceIds();
		const current = await this.adapter.getForeignObjectAsync(ids.userId);
		const next = this._buildUserObject(current);
		const currentCommon = this._isRecord(current?.common) ? current.common : {};
		const needsWrite =
			!current ||
			current.type !== 'user' ||
			!this._objectsEqualForBaseline(
				{
					name: currentCommon.name,
					desc: currentCommon.desc,
					password: currentCommon.password,
					enabled: currentCommon.enabled,
					icon: currentCommon.icon,
				},
				{
					name: next.common.name,
					desc: next.common.desc,
					password: next.common.password,
					enabled: next.common.enabled,
					icon: next.common.icon,
				},
			);
		if (!needsWrite) {
			return;
		}
		await this.adapter.setForeignObjectAsync(ids.userId, next);
	}

	/**
	 * Ensure the canonical group object exists and matches the baseline fields except membership.
	 *
	 * Membership is enforced separately so tests can isolate the correction path.
	 *
	 * @returns {Promise<void>} Resolves when the group object is correct.
	 */
	async _ensureGroup() {
		const ids = this._buildReferenceIds();
		const current = await this.adapter.getForeignObjectAsync(ids.groupId);
		const next = this._buildGroupObject(current);
		const currentCommon = this._isRecord(current?.common) ? current.common : {};
		const needsWrite =
			!current ||
			current.type !== 'group' ||
			!this._objectsEqualForBaseline(
				{
					name: currentCommon.name,
					desc: currentCommon.desc,
					acl: currentCommon.acl,
					enabled: currentCommon.enabled,
					icon: currentCommon.icon,
				},
				{
					name: next.common.name,
					desc: next.common.desc,
					acl: next.common.acl,
					enabled: next.common.enabled,
					icon: next.common.icon,
				},
			);
		if (!needsWrite) {
			return;
		}
		await this.adapter.setForeignObjectAsync(ids.groupId, next);
	}

	/**
	 * Ensure the canonical group contains exactly the canonical user.
	 *
	 * @returns {Promise<void>} Resolves when membership is correct.
	 */
	async _ensureMembership() {
		const ids = this._buildReferenceIds();
		const current = await this.adapter.getForeignObjectAsync(ids.groupId);
		const next = this._buildGroupObject(current);
		const currentMembers = this._normalizeMembers(current?.common?.members);
		const nextMembers = this._normalizeMembers(next.common.members);
		if (this._objectsEqualForBaseline(currentMembers, nextMembers)) {
			return;
		}
		await this.adapter.setForeignObjectAsync(ids.groupId, next);
	}

	/**
	 * Set a fresh controller-managed password for the canonical user.
	 *
	 * @returns {Promise<void>} Resolves when the password was set.
	 */
	async _ensurePassword() {
		const ids = this._buildReferenceIds();
		await this.adapter.setPasswordAsync(ids.userShortName, this._generatePassword());
	}

	/**
	 * Compare two JSON-safe baseline fragments.
	 *
	 * @param {any} actual Actual fragment.
	 * @param {any} expected Expected fragment.
	 * @returns {boolean} `true` when both fragments are baseline-equal.
	 */
	_objectsEqualForBaseline(actual, expected) {
		return JSON.stringify(actual) === JSON.stringify(expected);
	}

	/**
	 * Normalize a member list to sorted unique user ids.
	 *
	 * @param {any} members Raw member list.
	 * @returns {string[]} Canonical member ids.
	 */
	_normalizeMembers(members) {
		if (!Array.isArray(members)) {
			return [];
		}
		const normalized = [];
		for (const member of members) {
			const value = typeof member === 'string' ? member.trim() : '';
			if (!value || normalized.includes(value)) {
				continue;
			}
			normalized.push(value);
		}
		return normalized.sort((a, b) => a.localeCompare(b));
	}

	/**
	 * Read available `web.*` instances through the verified controller view path.
	 *
	 * The current package does not mutate `web.*` config, but the normalized result
	 * is kept inside the baseline owner for the public-web scope.
	 *
	 * @returns {Promise<Array<{
	 *   id: string,
	 *   value: string,
	 *   defaultUser: string,
	 *   enabled: boolean,
	 *   usesReferenceUser: boolean
	 * }>>} Normalized web instance descriptors.
	 */
	async _readWebInstances() {
		const ids = this._buildReferenceIds();
		const result = await this.adapter.getObjectViewAsync('system', 'instance', {
			startkey: 'system.adapter.web.',
			endkey: 'system.adapter.web.\u9999',
		});
		const rows = Array.isArray(result?.rows) ? result.rows : [];
		const instances = [];
		for (const row of rows) {
			const id = typeof row?.id === 'string' ? row.id.trim() : '';
			const value = id.startsWith('system.adapter.') ? id.slice('system.adapter.'.length) : id;
			const defaultUser =
				typeof row?.value?.native?.defaultUser === 'string' ? row.value.native.defaultUser.trim() : '';
			const enabled = row?.value?.common?.enabled !== false;
			if (!id || !value) {
				continue;
			}
			instances.push({
				id,
				value,
				defaultUser,
				enabled,
				usesReferenceUser: defaultUser === ids.userShortName,
			});
		}
		return instances;
	}

	/**
	 * Test whether a value is a plain object record.
	 *
	 * @param {any} value Value to test.
	 * @returns {value is Record<string, any>} `true` for plain records.
	 */
	_isRecord(value) {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	/**
	 * Pick one random character from a source string.
	 *
	 * @param {string} chars Allowed characters.
	 * @returns {string} One character.
	 */
	_pickRandomChar(chars) {
		if (!chars) {
			throw new Error('IoSystemBaseline: character source must not be empty');
		}
		const index = crypto.randomInt(chars.length);
		return chars[index];
	}

	/**
	 * Shuffle a character list in place and return it.
	 *
	 * @param {string[]} chars Character array.
	 * @returns {string[]} Shuffled array.
	 */
	_shuffleChars(chars) {
		const out = Array.isArray(chars) ? chars.slice() : [];
		for (let index = out.length - 1; index > 0; index -= 1) {
			const swapIndex = crypto.randomInt(index + 1);
			const tmp = out[index];
			out[index] = out[swapIndex];
			out[swapIndex] = tmp;
		}
		return out;
	}
}

module.exports = { IoSystemBaseline };
