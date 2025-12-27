// Backwards-compat wrapper: i18n helpers live in `src/MsgUtils.js`.
'use strict';

const { pickI18n, formatI18n } = require('./MsgUtils');

module.exports = { pickI18n, formatI18n };
