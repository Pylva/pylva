// Auth module barrel export
export { signJwt, verifyJwt, revokeJwt, refreshJwtIfNeeded } from './jwt.js';
export {
  generateApiKey,
  validateApiKey,
  revokeApiKey,
  rotateApiKey,
  initApiKeyRevocationListener,
} from './api-key.js';
export {
  withApiKeyAuth,
  withJwtAuth,
  withRateLimit,
  setRefreshCookie,
  RATE_LIMIT_PRESETS,
} from './middleware.js';
export { auditLog } from './audit-log.js';
export {
  checkCustomerLimit,
  checkCustomerLimitAgainstLimitInTransaction,
  checkCustomerLimitInTransaction,
  checkFeatureGate,
  shouldShowUpgradeBanner,
  tierUsageHeader,
} from './tier-enforcement.js';
export {
  customerLimitLockKey,
  getBuilderEntitlementForShare,
  lockCustomerLimit,
} from '../db/advisory-locks.js';
