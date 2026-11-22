'use strict';

// Security building blocks are intentionally exported separately.
// They are not mounted on the HTTP routes until the complete login,
// persistence, CSRF, cookie and recovery flows are implemented and tested.

module.exports = {
  authenticator: require('./authenticator'),
  encryption: require('./encryption'),
  session: require('./session'),
  tradeGuard: require('./trade-guard')
};
