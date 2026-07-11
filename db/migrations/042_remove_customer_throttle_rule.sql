-- Remove the customer_throttle rule type.
--
-- Budget_limit hard stops are now the customer-usage control primitive.
-- Existing customer_throttle rules and their rule_events are removed so
-- they cannot remain as hidden SDK-enforced behavior after the UI/API/SDK
-- surfaces disappear.

DELETE FROM rule_events
 WHERE event_type = 'throttle_blocked'
    OR rule_id IN (
      SELECT id
        FROM rules
       WHERE type = 'customer_throttle'
    );

DELETE FROM rules
 WHERE type = 'customer_throttle';

ALTER TABLE rules
  DROP CONSTRAINT IF EXISTS rules_type_check;

ALTER TABLE rules
  ADD CONSTRAINT rules_type_check
  CHECK (type IN (
    'cost_threshold',
    'budget_limit',
    'model_routing',
    'reliability_failover',
    'margin_protection'
  ));
