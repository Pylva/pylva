export const COST_SOURCE_PROTECTION_STATES = [
  'protected',
  'ready_to_protect',
  'tracking_only',
  'unpriced_uncontrolled',
] as const;

export type CostSourceProtectionState = (typeof COST_SOURCE_PROTECTION_STATES)[number];

export interface CostSourceProtectionInput {
  trackingStatus: 'tracked' | 'pending' | 'ignored';
  healthStatus: 'healthy' | 'warning' | 'broken';
  hasPricing: boolean;
  authoritativeEnabled: boolean;
  controlReady: boolean;
  hasActiveHardStopBudget: boolean;
}

export function deriveCostSourceProtectionState(
  input: CostSourceProtectionInput,
): CostSourceProtectionState {
  if (input.trackingStatus !== 'tracked' || input.healthStatus === 'broken' || !input.hasPricing) {
    return 'unpriced_uncontrolled';
  }
  if (!input.authoritativeEnabled || !input.controlReady) return 'tracking_only';
  if (!input.hasActiveHardStopBudget) return 'ready_to_protect';
  return 'protected';
}
