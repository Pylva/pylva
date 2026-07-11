// LLM pricing table types — spec Section 4.11

export interface LlmPricingEntry {
  id: number;
  provider: string;
  model: string;
  input_per_1m: number; // USD per 1M input tokens
  output_per_1m: number; // USD per 1M output tokens
  effective_from: Date;
  effective_to: Date | null; // null = currently active
  source: 'auto' | 'admin';
  created_at: Date;
}

export interface PricingResponse {
  models: LlmPricingEntry[];
  updated_at: string; // ISO 8601
}

export interface NonLlmPricingEntry {
  id: string;
  builder_id: string;
  customer_id: string | null; // null = default for all customers
  metric: string; // e.g., "characters", "api_calls"
  unit_price_usd: number; // price per unit
  unit_label: string; // e.g., "per 1K characters"
  effective_from: Date;
  effective_to: Date | null;
  created_at: Date;
}
