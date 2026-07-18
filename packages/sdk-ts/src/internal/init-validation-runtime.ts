// Shared provider patch/warning state. Provider and root entrypoints import
// this one physical module so init validation observes every patch.

export { markProviderPatched, validateFailoverWrappers } from '../wrappers/_init_validation.js';
