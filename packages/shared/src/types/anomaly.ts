// Anomaly detection types — spec Section 3.4

export interface AnomalyConfig {
  threshold_percent: 15; // 15% deviation triggers alert
  lookback_days: 30; // Compare against 30-day moving average
  min_data_points: 7; // Require 7 days of data before alerting
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  threshold_percent: 15,
  lookback_days: 30,
  min_data_points: 7,
};

export interface AnomalyAlert {
  id: string;
  builder_id: string;
  customer_id: string;
  metric: string;
  current_value: number;
  expected_value: number;
  deviation_percent: number;
  direction: 'above' | 'below';
  period_start: string; // ISO 8601
  period_end: string;
  detected_at: string;
}
