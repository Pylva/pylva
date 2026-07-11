// Cost simulator types — spec Section 3.6

export const OTHERS_CUSTOMER_ID = '__others__';

export interface ModelSwap {
  from_model: string;
  to_model: string;
  from_provider: string;
  to_provider: string;
}

export interface SimulatorRequest {
  builder_id: string;
  customer_id: string | null; // null = simulate across all customers
  period_start: string; // ISO 8601
  period_end: string;
  model_swaps: ModelSwap[];
}

export interface SimulatorResult {
  original_cost_usd: number;
  simulated_cost_usd: number;
  savings_usd: number;
  savings_percent: number;
  breakdown: SimulatorBreakdown[];
  period_start: string;
  period_end: string;
  freshness_timestamp: string | null;
  warnings: string[];
}

export interface SimulatorBreakdown {
  customer_id: string;
  provider: string;
  step_name: string | null;
  original_model: string;
  simulated_model: string;
  original_cost_usd: number;
  simulated_cost_usd: number;
  event_count: number;
}
