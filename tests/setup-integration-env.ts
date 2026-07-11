process.env['DATABASE_URL'] ??= 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
process.env['CLICKHOUSE_URL'] ??= 'http://localhost:8123';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
process.env['JWT_PRIVATE_KEY'] ??= '/tmp/pylva-ci-private.pem';
process.env['JWT_PUBLIC_KEY'] ??= '/tmp/pylva-ci-public.pem';
process.env['ARGON2_SECRET'] ??= 'test-secret';
process.env['STRIPE_WEBHOOK_SECRET'] ??= 'whsec_test_connect';
process.env['CRON_SECRET'] ??= '12345678901234567890123456789012';
