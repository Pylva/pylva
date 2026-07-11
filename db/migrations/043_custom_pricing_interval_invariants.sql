-- Keep custom_pricing version chains deterministic and non-overlapping.
--
-- Older writes could leave multiple open rows for the same pricing key. Clamp
-- every row to the next later version before adding the one-open-row invariant.

WITH ordered_llm AS (
  SELECT
    id,
    LEAD(effective_from) OVER (
      PARTITION BY builder_id, provider, model
      ORDER BY effective_from ASC, created_at ASC, id ASC
    ) AS next_effective_from
  FROM custom_pricing
  WHERE provider IS NOT NULL
    AND model IS NOT NULL
    AND metric IS NULL
)
UPDATE custom_pricing AS cp
SET effective_to = ordered_llm.next_effective_from,
    updated_at = NOW()
FROM ordered_llm
WHERE cp.id = ordered_llm.id
  AND ordered_llm.next_effective_from IS NOT NULL
  AND (cp.effective_to IS NULL OR cp.effective_to > ordered_llm.next_effective_from);

WITH ordered_metric AS (
  SELECT
    id,
    LEAD(effective_from) OVER (
      PARTITION BY builder_id, metric
      ORDER BY effective_from ASC, created_at ASC, id ASC
    ) AS next_effective_from
  FROM custom_pricing
  WHERE provider IS NULL
    AND model IS NULL
    AND metric IS NOT NULL
)
UPDATE custom_pricing AS cp
SET effective_to = ordered_metric.next_effective_from,
    updated_at = NOW()
FROM ordered_metric
WHERE cp.id = ordered_metric.id
  AND ordered_metric.next_effective_from IS NOT NULL
  AND (cp.effective_to IS NULL OR cp.effective_to > ordered_metric.next_effective_from);

CREATE UNIQUE INDEX idx_custom_pricing_llm_one_open
  ON custom_pricing(builder_id, provider, model)
  WHERE provider IS NOT NULL
    AND model IS NOT NULL
    AND metric IS NULL
    AND effective_to IS NULL;

CREATE UNIQUE INDEX idx_custom_pricing_metric_one_open
  ON custom_pricing(builder_id, metric)
  WHERE provider IS NULL
    AND model IS NULL
    AND metric IS NOT NULL
    AND effective_to IS NULL;
